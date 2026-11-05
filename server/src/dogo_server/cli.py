import argparse
import getpass

import uvicorn

from .bootstrap import create_container
from .config import Settings
from .domain.errors import DomainError


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
    container = create_container(Settings.from_env())
    try:
        result = container.identity.create_account(args.username, password)
    except DomainError as error:
        parser.error(error.message)
    print(f"Created account: {result['username']}")
