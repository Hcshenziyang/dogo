import argparse
import getpass

import uvicorn

from .auth import Auth
from .config import Settings
from .db import Database
from .errors import ServiceError


def main() -> None:
    parser = argparse.ArgumentParser(description="DogO server")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-user", help="Create an account locally; no public sign-up")
    create.add_argument("username")
    serve = commands.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if args.command == "serve":
        uvicorn.run(
            "dogo_server.app:create_app",
            factory=True,
            host=args.host,
            port=args.port,
            workers=1,
            ws_max_size=2 * 1024 * 1024,
        )
        return
    password = getpass.getpass("Password (at least 10 characters): ")
    if password != getpass.getpass("Confirm password: "):
        parser.error("Passwords do not match")
    settings = Settings.from_env()
    db = Database(settings.data_dir / "dogo.sqlite")
    db.initialize()
    try:
        result = Auth(db, settings).create_account(args.username, password)
    except ServiceError as error:
        parser.error(error.message)
    print(f"Created account: {result['username']}")
