#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import stat
from pathlib import Path

import yaml


def env_value(path: Path, key: str) -> str:
    if not path.is_file():
        raise SystemExit("Hermes environment file is missing")
    pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}\s*=\s*(.*?)\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if not match:
            continue
        return match.group(1).strip().strip("\"'")
    raise SystemExit(f"{key} is missing")


def set_env_value(path: Path, key: str, value: str) -> None:
    original = path.read_text(encoding="utf-8").splitlines()
    pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}\s*=")
    updated: list[str] = []
    replaced = False
    for line in original:
        if not pattern.match(line):
            updated.append(line)
            continue
        if not replaced:
            updated.append(f"{key}={value}")
            replaced = True
    if not replaced:
        updated.append(f"{key}={value}")

    mode = stat.S_IMODE(path.stat().st_mode)
    temporary = path.with_suffix(".env.errandos-screen.tmp")
    temporary.write_text("\n".join(updated) + "\n", encoding="utf-8")
    temporary.chmod(mode)
    temporary.replace(path)


def main() -> None:
    home = Path(os.environ.get("HERMES_HOME", "/root/.hermes"))
    config_path = home / "config.yaml"
    env_path = home / ".env"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    if not isinstance(config, dict):
        raise SystemExit("Hermes config is invalid")

    allowed = [
        value.strip()
        for value in env_value(env_path, "TELEGRAM_ALLOWED_USERS").split(",")
        if value.strip()
    ]
    if len(allowed) != 1 or allowed[0] == "*" or not allowed[0].isdigit():
        raise SystemExit("Owner-only /screen requires exactly one numeric Telegram allowed user")

    gateway = config.setdefault("gateway", {})
    platforms = gateway.setdefault("platforms", {})
    telegram = platforms.setdefault("telegram", {})
    extra = telegram.setdefault("extra", {})
    extra["allow_from"] = allowed
    extra["allow_admin_from"] = allowed
    extra["user_allowed_commands"] = []
    extra["group_allow_admin_from"] = []
    extra["group_user_allowed_commands"] = []

    quick_commands = config.setdefault("quick_commands", {})
    quick_commands["screen"] = {
        "type": "exec",
        "command": "/root/product-build-repos/errandos/scripts/capture-blinkit-screen.sh",
    }

    mode = stat.S_IMODE(config_path.stat().st_mode)
    temporary = config_path.with_suffix(".yaml.errandos-screen.tmp")
    temporary.write_text(
        yaml.safe_dump(config, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    temporary.chmod(mode)
    temporary.replace(config_path)
    set_env_value(env_path, "TELEGRAM_HOME_CHANNEL", allowed[0])
    print("owner_only_screen_command_configured=true")


if __name__ == "__main__":
    main()
