import os
import json
import logging
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mcp_client.agent import OndcAgent

logger = logging.getLogger(__name__)

app = FastAPI(title="ONDC RAG Chatbot", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(FRONTEND_DIR, "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

agent = OndcAgent()


class QueryRequest(BaseModel):
    query: str
    session_id: str = "default"
    query_from: str = "all"


@app.get("/", response_class=HTMLResponse)
async def get_ui():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.post("/search-stream")
async def search_stream(req: QueryRequest):
    """
    SSE endpoint.  Each frame is:
        data: {"type": "...", ...}\n\n
    The double newline is required by the SSE spec — the browser's
    EventSource won't fire 'message' events without it.
    """

    async def event_generator():
        try:
            async for json_line in agent.stream_query(req.query, req.session_id, query_from=req.query_from):
                # json_line already ends with \n from the agent.
                # SSE needs an extra \n to close the frame.
                yield f"data: {json_line.rstrip()}\n\n"
        except Exception as exc:
            logger.error(f"SSE generator error: {exc}", exc_info=True)
            error_frame = json.dumps({"type": "error", "data": str(exc)})
            yield f"data: {error_frame}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # prevent Nginx from buffering
            "Connection": "keep-alive",
        },
    )


@app.post("/search")
async def search(req: QueryRequest) -> dict:
    try:
        answer = await agent.query(req.query, req.session_id, query_from=req.query_from)
        return {"query": req.query, "answer": answer}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
