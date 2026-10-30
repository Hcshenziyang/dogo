"""Disposable local API for Android/JVM tests. Never reads the real DogO data dir."""

import tempfile
from pathlib import Path

import uvicorn
from dogo_server.app import create_app
from dogo_server.config import Settings
from dogo_server.schemas import Login


def main():
    with tempfile.TemporaryDirectory(prefix="dogo-android-test-") as directory:
        app = create_app(
            Settings(
                data_dir=Path(directory),
                allowed_hosts=("127.0.0.1", "localhost", "10.0.2.2"),
            )
        )
        app.state.auth.create_account("android-test", "android-test-password")
        app.state.auth.login(
            Login(
                username="android-test",
                password="android-test-password",
                device_id="test-offline-desktop",
                device_name="离线测试电脑",
                device_kind="desktop",
            )
        )
        uvicorn.run(
            app, host="127.0.0.1", port=18765, log_level="warning", access_log=False
        )


if __name__ == "__main__":
    main()
