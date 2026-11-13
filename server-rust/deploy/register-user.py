#!/usr/bin/env python3
"""Create a DogO account on the server without displaying its credentials."""

import getpass
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

INVITE_FILE = Path("/etc/dogo-rust/registration.env")
REGISTER_URL = "http://127.0.0.1:8788/api/auth/register"


def main():
    if not sys.stdin.isatty():
        raise SystemExit("请在服务器的交互式终端中运行。")
    username = input("新用户名（请勿使用旧账户的用户名）：").strip().lower()
    if not username or len(username) > 100:
        raise SystemExit("用户名须为 1–100 个字符。")
    password = getpass.getpass("密码（10–256 个字符）：")
    if not 10 <= len(password) <= 256:
        raise SystemExit("密码须为 10–256 个字符。")
    if password != getpass.getpass("再次输入密码："):
        raise SystemExit("两次输入的密码不一致。")

    prefix = "DOGO_RUST_INVITE_CODE="
    lines = INVITE_FILE.read_text().splitlines()
    invites = [line[len(prefix) :] for line in lines if line.startswith(prefix)]
    if len(invites) != 1 or not invites[0]:
        raise SystemExit("邀请码配置无效，请检查服务端配置。")
    body = json.dumps(
        {"username": username, "password": password, "invite_code": invites[0]}
    ).encode("utf-8")
    request = urllib.request.Request(
        REGISTER_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 201:
                raise SystemExit("注册未成功。")
    except urllib.error.HTTPError as error:
        if error.code == 409:
            raise SystemExit("用户名已存在，请更换。") from None
        raise SystemExit(f"注册失败（HTTP {error.code}）。") from None
    except urllib.error.URLError:
        raise SystemExit("无法连接 DogO 服务。") from None
    print("注册成功，可使用新账户登录。")


if __name__ == "__main__":
    main()
