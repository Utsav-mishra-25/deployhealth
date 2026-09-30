import os

target = os.getenv("DEPLOY_TARGET", "staging")
key = os.environ["DEPLOY_KEY"]
region = os.getenv("DEPLOY_REGION") or "eu"
