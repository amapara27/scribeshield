"""Environment-driven settings for the CareCaller backend."""
from __future__ import annotations

import sys
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Person B
    ANTHROPIC_API_KEY: SecretStr = SecretStr("")
    TAVILY_API_KEY: SecretStr = SecretStr("")

    # Person A
    ELEVENLABS_API_KEY: SecretStr = SecretStr("")
    # Backward-compatible alias (some env files use ELEVEN_LABS_API_KEY)
    ELEVEN_LABS_API_KEY: SecretStr = SecretStr("")
    HF_TOKEN: SecretStr = SecretStr("")
    HUGGINGFACE_HUB_TOKEN: SecretStr = SecretStr("")

    # Tunables
    CLAUDE_MODEL: str = "claude-sonnet-4-5"
    TAVILY_CALL_CAP: int = 5
    TAVILY_CACHE_TTL_SEC: int = 3600
    FRONTEND_ORIGIN: str = "http://localhost:8080"
    STREAM_TOKEN_TTL_SEC: int = 60
    SCRIBE_REALTIME_MODEL_ID: str = "scribe_v2_realtime"
    SCRIBE_REALTIME_WS_URL: str = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
    STT_PROVIDER: str = "auto"
    FINE_TUNED_STT_MODEL_PATH: Path = BACKEND_DIR / "tuned_models" / "full_ft"
    FINE_TUNED_STT_LANGUAGE: str = "english"
    FINE_TUNED_STT_TASK: str = "transcribe"
    FINE_TUNED_STT_DEVICE: str = "auto"
    FINE_TUNED_STT_DTYPE: str = "auto"
    FINE_TUNED_STT_WORD_TIMESTAMPS: bool = False
    XGBOOST_RUNTIME_ENABLED: bool = False
    XGBOOST_MODEL_PATH: Path = BACKEND_DIR / "xgb" / "artifacts" / "word_risk_xgb.joblib"
    XGBOOST_LOW_THRESHOLD: float = 0.60
    XGBOOST_MEDIUM_THRESHOLD: float = 0.35

    BENCHMARK_RESULTS_PATH: Path = BACKEND_DIR / "data" / "benchmark_results.json"

    # Optional: full paths if ffmpeg is installed but not on PATH (common with IDE-started Uvicorn).
    FFMPEG_PATH: str = ""
    FFPROBE_PATH: str = ""

    def elevenlabs_api_key(self) -> str:
        primary = self.ELEVENLABS_API_KEY.get_secret_value().strip()
        if primary:
            return primary
        return self.ELEVEN_LABS_API_KEY.get_secret_value().strip()

    def huggingface_token(self) -> str:
        primary = self.HF_TOKEN.get_secret_value().strip()
        if primary:
            return primary
        return self.HUGGINGFACE_HUB_TOKEN.get_secret_value().strip()

    def ffmpeg_ffprobe_explicit(self) -> tuple[str | None, str | None]:
        """Return optional explicit paths for preprocess_for_scribe."""
        ff = self.FFMPEG_PATH.strip() or None
        fp = self.FFPROBE_PATH.strip() or None
        if ff and not fp:
            parent = Path(ff).expanduser().resolve().parent
            for name in ("ffprobe.exe", "ffprobe") if sys.platform == "win32" else ("ffprobe",):
                sibling = parent / name
                if sibling.is_file():
                    fp = str(sibling.resolve())
                    break
        return ff, fp


settings = Settings()
