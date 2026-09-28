import os

DATABASE_URL = os.environ["DATABASE_URL"]
SENTRY_DSN = os.getenv("SENTRY_DSN")
DEBUG = os.environ.get("WORKER_DEBUG")
