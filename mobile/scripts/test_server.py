"""Disposable local API for Android/JVM tests. Never reads the real DogO data dir."""

import tempfile
from pathlib import Path

import uvicorn
from dogo_server.app import create_app
from dogo_server.application.commands import DispatchAck
from dogo_server.application.identity import LoginCommand
from dogo_server.config import Settings


def main():
    with tempfile.TemporaryDirectory(prefix="dogo-android-test-") as directory:
        app = create_app(
            Settings(
                data_dir=Path(directory),
                allowed_hosts=("127.0.0.1", "localhost", "10.0.2.2"),
            )
        )
        app.state.container.identity.create_account(
            "android-test", "android-test-password"
        )
        desktop = app.state.container.identity.login(
            LoginCommand(
                username="android-test",
                password="android-test-password",
                device_id="test-offline-desktop",
                device_name="离线测试电脑",
                device_kind="desktop",
            )
        )
        # Test-only helpers, available solely on this disposable loopback server.
        principal = app.state.container.identity.authenticate(desktop["access_token"])

        @app.post("/api/test/claim")
        def claim():
            app.state.container.scheduler.tick(
                principal.account_id, principal.device_id
            )
            return app.state.container.deliveries.next_delivery(principal) or {}

        @app.post("/api/test/ack")
        def acknowledge(data: dict):
            return app.state.container.deliveries.acknowledge(
                principal,
                DispatchAck(
                    type="dispatch.ack",
                    dispatch_id=data["id"],
                    lease_token=data["lease_token"],
                    native_session_id="mobile-test-session",
                ),
            )

        uvicorn.run(
            app, host="127.0.0.1", port=18765, log_level="warning", access_log=False
        )


if __name__ == "__main__":
    main()
