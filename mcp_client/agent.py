import asyncio
import logging
import json
from typing import List, Any, AsyncGenerator, Dict
from datetime import datetime

from fastmcp import Client
from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    ToolMessage,
    SystemMessage,
)
from mcp_client.config import settings
from mcp_client.llm_utils import get_llm

logger = logging.getLogger(__name__)

MCP_SERVER_URL = settings.mcp_server_url
logger.info(f"Using MCP_SERVER_URL: {MCP_SERVER_URL}")


class OndcAgent:
    def __init__(self, mcp_url: str = MCP_SERVER_URL):
        self.mcp_url = mcp_url
        self.llm = get_llm()
        self.sessions: Dict[str, List[BaseMessage]] = {}

    # Session management

    def _get_session_messages(self, session_id: str) -> List[BaseMessage]:
        if session_id not in self.sessions:
            self.sessions[session_id] = [
                SystemMessage(
                    content=(
                        f"You are an ONDC {settings.default_domain} API assistant "
                        f"(v{settings.default_api_version}). "
                        f"Today is {datetime.now().strftime('%A, %B %d, %Y')}. "
                        "Use the provided tools to search the knowledge base and "
                        "answer questions accurately. "
                        "Always respond in clean Markdown format. "
                        "When you have enough information, stop calling tools and "
                        "write your final answer directly."
                    )
                )
            ]
        return self.sessions[session_id]

    def clear_session(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)

    # Tool execution

    async def _execute_tool(self, mcp_client: Client, tool_call: Any) -> ToolMessage:
        name = tool_call["name"]
        args = tool_call["args"]
        tool_call_id = tool_call["id"]

        logger.info(f"Executing tool: {name} | args: {json.dumps(args)[:120]}")
        try:
            result = await mcp_client.call_tool(name, args)

            # FastMCP returns a CallToolResult whose .content is a list of
            # TextContent / ImageContent / etc.  Flatten to a plain string.
            if hasattr(result, "content") and isinstance(result.content, list):
                content = "".join(
                    getattr(item, "text", str(item)) for item in result.content
                )
            else:
                content = str(result)

            logger.debug(f"Tool {name} returned {len(content)} chars")
            return ToolMessage(content=content, tool_call_id=tool_call_id)

        except Exception as exc:
            logger.error(f"Tool {name} failed: {exc}", exc_info=True)
            return ToolMessage(content=f"Tool error: {exc}", tool_call_id=tool_call_id)

    #  Core streaming loop ─

    async def stream_query(
        self,
        user_query: str,
        session_id: str = "default",
        query_from: str = "all",
    ) -> AsyncGenerator[str, None]:
        """
        Yields newline-delimited JSON strings (NOT SSE-framed).
        """
        messages = self._get_session_messages(session_id)

        # Add a mode reminder to the LLM so it knows which tools to use/avoid
        mode_reminder = f"DATABASE_MODE: {query_from}. "
        if query_from == "milvus":
            mode_reminder += "You are currently in Milvus-only mode. Use ONLY semantic search (smart_search) or discover_schema. All Neo4j graph tools are DISABLED."
        elif query_from == "neo4j":
            mode_reminder += "You are currently in Neo4j-only mode. Use Neo4j graph tools (get_action_rules, get_field_rules, etc.) or smart_search (strictly limited to Neo4j text search)."
        else:
            mode_reminder += "You are in hybrid mode. All databases (Milvus and Neo4j) are available. Use the best tool for the query."

        # Insert as a fresh context reminder
        messages.append(SystemMessage(content=mode_reminder))
        messages.append(HumanMessage(content=user_query))

        try:
            async with Client(self.mcp_url) as mcp_client:
                mcp_tools = await mcp_client.list_tools()

                # Categorize tools
                neo4j_only_tools = {
                    "get_action_rules",
                    "get_field_rules",
                    "get_session_flow",
                    "get_cross_conflicts",
                }

                tool_schemas = []
                allowed_tool_names = set()

                for t in mcp_tools:
                    # Strict tool filtering by query_from
                    if query_from == "milvus":
                        # For Milvus, ONLY allow semantic search and discovery
                        if t.name in ["smart_search", "discover_schema"]:
                            allowed_tool_names.add(t.name)
                        else:
                            continue
                    elif query_from == "neo4j":
                        # For Neo4j, allow all Neo4j tools + hybrid tools
                        allowed_tool_names.add(t.name)
                    else:
                        # For "all", everything is allowed
                        allowed_tool_names.add(t.name)

                    tool_schemas.append(
                        {
                            "type": "function",
                            "function": {
                                "name": t.name,
                                "description": t.description or "",
                                "parameters": t.inputSchema,
                            },
                        }
                    )

                logger.info(
                    f"Bound {len(tool_schemas)} tools to LLM (mode={query_from}). Allowed: {allowed_tool_names}"
                )
                llm_with_tools = self.llm.bind_tools(tool_schemas)

                for iteration in range(15):
                    logger.info(f"Agent iteration {iteration + 1}")
                    yield _json_line("status", f"Thinking… (step {iteration + 1})")

                    #  Stream one LLM turn
                    accumulated = None
                    in_think_block = False
                    think_buffer = ""

                    async for chunk in llm_with_tools.astream(messages):
                        # Accumulate for tool-call detection
                        accumulated = (
                            chunk if accumulated is None else accumulated + chunk
                        )

                        text = chunk.content if isinstance(chunk.content, str) else ""
                        if not text:
                            continue

                        # Handle <think>…</think> blocks emitted by some models
                        # (e.g. qwen3). Strip them from the visible stream but
                        # emit a separate "thinking" event so the UI can show them.
                        if "<think>" in text:
                            in_think_block = True
                            before, _, after = text.partition("<think>")
                            if before:
                                yield _json_line("content", before)
                            think_buffer = after
                            continue

                        if in_think_block:
                            if "</think>" in text:
                                in_think_block = False
                                think_buffer, _, after = (
                                    think_buffer + text
                                ).partition("</think>")
                                if think_buffer:
                                    yield _json_line("thinking", think_buffer)
                                think_buffer = ""
                                if after:
                                    yield _json_line("content", after)
                            else:
                                think_buffer += text
                            continue

                        yield _json_line("content", text)

                    #  Nothing came back
                    if accumulated is None:
                        logger.warning("LLM returned empty response, stopping.")
                        break

                    messages.append(accumulated)

                    #  No tool calls → final answer
                    if not accumulated.tool_calls:
                        yield _json_line("status", "Done.")
                        break

                    # Filter and Execute tool calls in parallel
                    valid_tool_calls = []
                    for tc in accumulated.tool_calls:
                        name = tc["name"]
                        if name not in allowed_tool_names:
                            logger.warning(
                                f"REJECTED Tool Call: {name} (not allowed in {query_from} mode)"
                            )
                            continue

                        # Propagate database preference to compatible tools
                        if name in ["smart_search", "discover_schema"]:
                            tc["args"]["query_from"] = query_from

                        yield json.dumps(
                            {
                                "type": "tool_start",
                                "name": tc["name"],
                                "args": tc["args"],
                            }
                        ) + "\n"
                        valid_tool_calls.append(tc)

                    if not valid_tool_calls:
                        logger.warning("No valid tool calls after filtering, stopping.")
                        break

                    tool_results: List[ToolMessage] = await asyncio.gather(
                        *[self._execute_tool(mcp_client, tc) for tc in valid_tool_calls]
                    )

                    for tc, res in zip(valid_tool_calls, tool_results):
                        preview = (
                            res.content[:300] + "…"
                            if len(res.content) > 300
                            else res.content
                        )
                        yield json.dumps(
                            {
                                "type": "tool_end",
                                "name": tc["name"],
                                "result": preview,
                            }
                        ) + "\n"

                    messages.extend(tool_results)

        except Exception as exc:
            logger.error(f"Agent error: {exc}", exc_info=True)
            yield _json_line("error", str(exc))

    #  Non-streaming convenience wrapper

    async def query(
        self, user_query: str, session_id: str = "default", query_from: str = "all"
    ) -> str:
        parts: List[str] = []
        async for line in self.stream_query(user_query, session_id, query_from):
            try:
                chunk = json.loads(line)
                if chunk.get("type") == "content":
                    parts.append(chunk["data"])
            except json.JSONDecodeError:
                pass
        return "".join(parts)


#  Helper


def _json_line(type_: str, data: str) -> str:
    return json.dumps({"type": type_, "data": data}) + "\n"
