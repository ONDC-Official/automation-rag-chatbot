import logging
from langchain_ollama import ChatOllama
from langchain_openai import ChatOpenAI
from .config import settings

log = logging.getLogger(__name__)

_llm = None


def get_llm() -> ChatOllama | ChatOpenAI:
    global _llm
    if _llm is not None:
        return _llm

    log.debug(f"Initializing LLM: {settings.generation_model}")

    if settings.ollama_api_key:
        log.debug("Using Cloud LLM via OpenAI-compatible interface")
        _llm = ChatOpenAI(
            model=settings.generation_model,
            base_url=settings.ollama_cloud_url,
            api_key=settings.ollama_api_key,
            streaming=True,  # must be explicit for streaming to work
            temperature=0,
        )
    else:
        log.debug("Using Local LLM via Ollama")
        _llm = ChatOllama(
            model=settings.generation_model,
            base_url=settings.ollama_base_url,
            temperature=0,
        )

    return _llm
