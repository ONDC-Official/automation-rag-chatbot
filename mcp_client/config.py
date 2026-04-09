import logging
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Setup Base Directory
BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Ollama / LLM
    ollama_base_url: str = "http://ollama:11434"
    ollama_cloud_url: str = "https://ollama.com/v1"
    ollama_api_key: str = ""
    embedding_model: str = "nomic-embed-text-v2-moe"
    generation_model: str = "qwen3-coder:480b-cloud"

    # ONDC domain info (for system prompts)
    default_domain: str = "ONDC:FIS12"
    default_api_version: str = "2.0.2"

    # MCP Server
    mcp_server_url: str = "http://mcp-server:8004/sse"

    # Log Level
    log_level: str = "INFO"


settings = Settings()

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
