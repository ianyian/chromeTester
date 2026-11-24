#!/usr/bin/env python3
"""Chrome Native Messaging host: returns this Linux tester's hostname and,
if present, the per-machine config file /etc/pcb-tester/tester.json.

Protocol: 4-byte little-endian length + UTF-8 JSON, on stdin/stdout.
"""
import json
import os
import socket
import struct
import sys

CONFIG_PATHS = [
    os.environ.get("PCB_TESTER_CONFIG", ""),
    "/etc/pcb-tester/tester.json",
    os.path.expanduser("~/.config/pcb-tester/tester.json"),
]
ALLOWED_KEYS = {"tester_id", "machine_name", "api_endpoint", "enabled", "retry_interval_sec"}


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def write_msg(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def load_config():
    for p in CONFIG_PATHS:
        if p and os.path.isfile(p):
            try:
                with open(p, encoding="utf-8") as f:
                    cfg = json.load(f)
                return {k: v for k, v in cfg.items() if k in ALLOWED_KEYS}, p
            except (OSError, ValueError) as e:
                return {}, f"{p}: {e}"
    return {}, None


def main():
    msg = read_msg() or {}
    if msg.get("cmd") == "hostinfo":
        cfg, src = load_config()
        write_msg({"hostname": socket.gethostname(), "config": cfg, "config_source": src})
    else:
        write_msg({"error": "unknown command"})


if __name__ == "__main__":
    main()
