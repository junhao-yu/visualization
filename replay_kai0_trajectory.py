#!/usr/bin/env python3
"""Replay recorded events into kai0_viewer_server.py.

Usage:
  python replay_kai0_trajectory.py \
    --input /tmp/infer_session.jsonl \
    --viewer-url http://127.0.0.1:9001
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from http.client import RemoteDisconnected
from urllib import request as urllib_request


def _post_json(url: str, payload: dict, timeout_s: float = 10.0) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout_s) as resp:
            status = int(getattr(resp, "status", 200))
            if status >= 400:
                raise RuntimeError(f"POST {url} failed with status {status}")
    except (RemoteDisconnected, TimeoutError, OSError) as exc:
        raise RuntimeError(
            f"Viewer request failed: {url} ({exc}). "
            "请先在 viewer 所在机器执行 start_kai0_viewer_in_container.sh，"
            "确认 /api/index 健康后再回放。"
        ) from exc


def _iter_events(path: Path):
    with path.open("r", encoding="utf-8") as fp:
        for line_no, line in enumerate(fp, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                yield line_no, json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_no}: {exc}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay recorded infer viewer events into a running viewer server.")
    parser.add_argument("--input", type=Path, required=True, help="Input JSONL produced by infer_viewer_record_proxy.py")
    parser.add_argument("--viewer-url", default="http://127.0.0.1:9001", help="Target infer_viewer_server base URL")
    parser.add_argument(
        "--respect-timestamps",
        action="store_true",
        help="Replay with recorded event timing instead of sending everything immediately.",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help="Timing scale when --respect-timestamps is enabled. 2.0 means 2x faster.",
    )
    parser.add_argument(
        "--reset-first",
        action="store_true",
        help="Reset the target viewer server before replay starts.",
    )
    args = parser.parse_args()

    if args.speed <= 0:
        raise ValueError("--speed must be positive")

    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"Replay input does not exist or is not a file: {input_path}")
    base_url = args.viewer_url.rstrip("/")

    if args.reset_first:
        _post_json(f"{base_url}/api/reset", {})

    previous_ts: float | None = None
    replayed = 0

    for _, event in _iter_events(input_path):
        event_type = event.get("event")
        if event_type == "session_start":
            previous_ts = float(event.get("recorded_at", time.time()))
            continue
        if event_type not in {"reset", "push"}:
            continue

        recorded_at = float(event.get("recorded_at", time.time()))
        if args.respect_timestamps and previous_ts is not None:
            delay = max(0.0, (recorded_at - previous_ts) / args.speed)
            if delay > 0:
                time.sleep(delay)
        previous_ts = recorded_at

        payload = event.get("payload") or {}
        endpoint = "/api/reset" if event_type == "reset" else "/api/push"
        _post_json(f"{base_url}{endpoint}", payload)
        replayed += 1

    print(f"Replayed {replayed} events into {base_url}")


if __name__ == "__main__":
    main()
