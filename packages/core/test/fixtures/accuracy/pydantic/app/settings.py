from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env")

    database_url: str
    port: int = 8000
    sentry_dsn: str | None = None
    secret_key: str
