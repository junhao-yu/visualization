#!/usr/bin/env python3
"""Serve the Kai0 infer viewer UI and accept live inference pushes.

Usage:
  python kai0_viewer_server.py --static-dir kai0_dual_piper_viewer --urdf-path ""

Open:
  http://127.0.0.1:9001/ee_viewer/index.html
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs
from urllib.parse import urlparse


DEFAULT_URDF_ROOT = Path("/home/xuhua_chen/Codes/mobile_aloha_sim_ros2")
DEFAULT_URDF_PATH = DEFAULT_URDF_ROOT / "aloha_new_description/urdf/aloha_new.urdf"
DEFAULT_STATIC_DIR = Path(__file__).resolve().parent / "kai0_dual_piper_viewer"

STATE = {
    "meta": {},
    "frames": [],
    "last_id": -1,
    "trajectory": [],
    "trajectory_pred": {},
    "trajectory_gt": {},
    "trajectory_ts": None,
}
LOCK = threading.Lock()


def _reset_state_locked() -> None:
    STATE["meta"] = {}
    STATE["frames"] = []
    STATE["last_id"] = -1
    STATE["trajectory"] = []
    STATE["trajectory_pred"] = {}
    STATE["trajectory_gt"] = {}
    STATE["trajectory_ts"] = None


def _apply_payload_locked(payload: dict, max_frames: int) -> None:
    """Apply one replay payload to STATE. Caller must hold LOCK."""
    meta = payload.get("meta") or {}
    trajectory = payload.get("trajectory")
    trajectory_pred = payload.get("trajectory_pred")
    trajectory_gt = payload.get("trajectory_gt")
    frames = payload.get("frames")
    frame = payload.get("frame")

    new_frames = []
    if isinstance(frame, dict):
        new_frames.append(frame)
    if isinstance(frames, list):
        new_frames.extend(item for item in frames if isinstance(item, dict))

    if meta:
        STATE["meta"].update(meta)
    if isinstance(trajectory, (list, dict)):
        STATE["trajectory"] = trajectory
        STATE["trajectory_ts"] = payload.get("timestamp") or time.time()
    if isinstance(trajectory_pred, (list, dict)):
        STATE["trajectory_pred"] = trajectory_pred
        STATE["trajectory_ts"] = payload.get("timestamp") or time.time()
    if isinstance(trajectory_gt, (list, dict)):
        STATE["trajectory_gt"] = trajectory_gt
        STATE["trajectory_ts"] = payload.get("timestamp") or time.time()
    for item in new_frames:
        STATE["last_id"] += 1
        item["id"] = STATE["last_id"]
        STATE["frames"].append(item)
    if len(STATE["frames"]) > max_frames:
        STATE["frames"] = STATE["frames"][-max_frames:]


def _replay_events(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid replay JSON at {path}:{line_no}: {exc}") from exc


def _catalog(results_root: Path) -> list[dict]:
    """Find the newest replay for every (episode, horizon) pair."""
    if not results_root.is_dir():
        return []
    latest: dict[tuple[int, int | None], tuple[float, Path]] = {}
    for replay_path in results_root.rglob("kai0_viewer_replay.jsonl"):
        try:
            relative = replay_path.relative_to(results_root)
        except ValueError:
            continue
        episode_id = None
        horizon = None
        for part in relative.parts:
            if part.startswith("episode_"):
                try:
                    episode_id = int(part.removeprefix("episode_"))
                except ValueError:
                    pass
            if part.startswith("horizon_"):
                try:
                    horizon = int(part.removeprefix("horizon_"))
                except ValueError:
                    pass
        if episode_id is None:
            continue
        # Legacy flat output has no horizon directory. Read its metadata so it
        # can still be selected alongside the new multi-horizon layout.
        if horizon is None:
            stats_path = replay_path.with_name("full_episode_stats.json")
            try:
                horizon = int(json.loads(stats_path.read_text()).get("action_steps_used_per_inference", 1))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                horizon = 1
        try:
            mtime = replay_path.stat().st_mtime
        except OSError:
            continue
        key = (episode_id, horizon)
        if key not in latest or mtime > latest[key][0]:
            latest[key] = (mtime, replay_path)
    entries = []
    for (episode_id, horizon), (mtime, path) in latest.items():
        entries.append({
            "episode_id": episode_id,
            "horizon": horizon,
            "label": f"Episode {episode_id} · {horizon} steps",
            "replay": str(path.relative_to(results_root)),
            "updated_at": mtime,
        })
    return sorted(entries, key=lambda item: (item["episode_id"], item["horizon"]))


def _json_response(handler: BaseHTTPRequestHandler, payload: dict, status: int = HTTPStatus.OK) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()
    handler.wfile.write(body)


def _resolve_resource_path(resource: str, urdf_path: Path, urdf_root: Path | None) -> tuple[str, Path | None]:
    if resource.startswith("package://"):
        parts = resource[len("package://") :].split("/", 1)
        if len(parts) != 2:
            return resource, None
        package, rel_path = parts
        candidates = [parent / package / rel_path for parent in urdf_path.parents]
        if urdf_root is not None:
            candidates.append(urdf_root / package / rel_path)
        mesh_ref = rel_path if rel_path.startswith("meshes/") else f"meshes/{rel_path}"
        for candidate in candidates:
            if candidate.exists():
                return mesh_ref, candidate
        return mesh_ref, None

    if resource.startswith("file://"):
        local_path = Path(resource[len("file://") :])
        return f"meshes/{local_path.name}", local_path

    local_path = Path(resource)
    if not local_path.is_absolute():
        local_path = (urdf_path.parent / local_path).resolve()
    return f"meshes/{local_path.name}", local_path


def _prepare_live_urdf_assets(urdf_path: Path, urdf_root: Path | None, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    meshes_dir = out_dir / "meshes"
    meshes_dir.mkdir(parents=True, exist_ok=True)
    urdf_text = urdf_path.read_text(encoding="utf-8")
    rewritten = urdf_text

    for match in set(re.findall(r'filename="([^"]+)"', urdf_text)):
        new_ref, src_path = _resolve_resource_path(match, urdf_path, urdf_root)
        rewritten = rewritten.replace(match, new_ref)
        if src_path is None or not src_path.exists():
            continue
        dst_path = meshes_dir / new_ref.replace("meshes/", "", 1)
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        if not dst_path.exists():
            shutil.copy2(src_path, dst_path)

    (out_dir / "robot.urdf").write_text(rewritten, encoding="utf-8")


class InferViewerHandler(BaseHTTPRequestHandler):
    server_version = "Kai0InferViewerHTTP/0.1"

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api_get(parsed)
            return
        self._serve_static(parsed.path)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/push":
            self._handle_api_push()
            return
        if parsed.path == "/api/load":
            self._handle_api_load()
            return
        if parsed.path == "/api/reset":
            self._handle_api_reset()
            return
        _json_response(self, {"error": "not_found"}, status=HTTPStatus.NOT_FOUND)

    def _handle_api_get(self, parsed) -> None:
        if parsed.path == "/api/index":
            with LOCK:
                payload = {
                    "meta": STATE["meta"],
                    "frames": STATE["frames"],
                    "last_id": STATE["last_id"],
                }
            _json_response(self, payload)
            return

        if parsed.path == "/api/stream":
            params = parse_qs(parsed.query)
            since = int(params.get("since", ["-1"])[0])
            with LOCK:
                payload = {
                    "frames": [frame for frame in STATE["frames"] if frame.get("id", -1) > since],
                    "last_id": STATE["last_id"],
                    "meta": STATE["meta"],
                }
            _json_response(self, payload)
            return

        if parsed.path == "/api/trajectory":
            with LOCK:
                payload = {
                    "trajectory": STATE.get("trajectory", []),
                    "trajectory_pred": STATE.get("trajectory_pred", {}),
                    "trajectory_gt": STATE.get("trajectory_gt", {}),
                    "updated_at": STATE.get("trajectory_ts"),
                }
            _json_response(self, payload)
            return

        if parsed.path == "/api/catalog":
            results_root: Path | None = getattr(self.server, "results_root", None)
            entries = _catalog(results_root) if results_root is not None else []
            _json_response(self, {"results_root": str(results_root) if results_root else None, "entries": entries})
            return

        _json_response(self, {"error": "not_found"}, status=HTTPStatus.NOT_FOUND)

    def _handle_api_push(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            _json_response(self, {"error": "empty_body"}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            _json_response(self, {"error": "invalid_json"}, status=HTTPStatus.BAD_REQUEST)
            return

        with LOCK:
            max_frames = getattr(self.server, "max_frames", 2000)
            _apply_payload_locked(payload, max_frames)

        _json_response(self, {"ok": True, "last_id": STATE["last_id"]})

    def _handle_api_load(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            _json_response(self, {"error": "empty_body"}, status=HTTPStatus.BAD_REQUEST)
            return
        try:
            request_payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            _json_response(self, {"error": "invalid_json"}, status=HTTPStatus.BAD_REQUEST)
            return
        if not isinstance(request_payload, dict):
            _json_response(self, {"error": "request_must_be_object"}, status=HTTPStatus.BAD_REQUEST)
            return

        results_root: Path | None = getattr(self.server, "results_root", None)
        if results_root is None:
            _json_response(self, {"error": "results_root_not_configured"}, status=HTTPStatus.NOT_FOUND)
            return
        replay_name = request_payload.get("replay")
        if replay_name:
            candidate = (results_root / str(replay_name)).resolve()
            if not str(candidate).startswith(str(results_root.resolve()) + "/"):
                _json_response(self, {"error": "invalid_replay_path"}, status=HTTPStatus.BAD_REQUEST)
                return
            replay_path = candidate
        else:
            try:
                episode_id = int(request_payload["episode_id"])
                horizon = int(request_payload["horizon"])
            except (KeyError, TypeError, ValueError):
                _json_response(self, {"error": "episode_id_and_horizon_required"}, status=HTTPStatus.BAD_REQUEST)
                return
            matches = [
                item for item in _catalog(results_root)
                if item["episode_id"] == episode_id and item["horizon"] == horizon
            ]
            if not matches:
                _json_response(self, {"error": "replay_not_found"}, status=HTTPStatus.NOT_FOUND)
                return
            replay_path = results_root / matches[0]["replay"]
        if not replay_path.is_file():
            _json_response(self, {"error": "replay_not_found"}, status=HTTPStatus.NOT_FOUND)
            return

        try:
            with LOCK:
                _reset_state_locked()
                for event in _replay_events(replay_path):
                    event_type = event.get("event")
                    if event_type == "reset":
                        _reset_state_locked()
                    elif event_type == "push":
                        _apply_payload_locked(event.get("payload") or {}, getattr(self.server, "max_frames", 2000))
        except (OSError, ValueError) as exc:
            _json_response(self, {"error": "replay_load_failed", "detail": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        _json_response(self, {"ok": True, "replay": str(replay_path.relative_to(results_root)), "last_id": STATE["last_id"]})

    def _handle_api_reset(self) -> None:
        with LOCK:
            _reset_state_locked()
        _json_response(self, {"ok": True})

    def _serve_static(self, path: str) -> None:
        static_dir: Path = getattr(self.server, "static_dir")
        target_path = "/index.html" if path in ("", "/") else path
        target = (static_dir / target_path.lstrip("/")).resolve()
        if not str(target).startswith(str(static_dir.resolve())):
            _json_response(self, {"error": "forbidden"}, status=HTTPStatus.FORBIDDEN)
            return
        if not target.exists() or not target.is_file():
            _json_response(self, {"error": "not_found"}, status=HTTPStatus.NOT_FOUND)
            return

        content = target.read_bytes()
        suffix = target.suffix.lower()
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".ico": "image/x-icon",
            ".stl": "model/stl",
            ".dae": "model/vnd.collada+xml",
            ".urdf": "application/xml; charset=utf-8",
        }.get(suffix, "application/octet-stream")

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(content)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the standalone Kai0 3D trajectory viewer.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9001)
    parser.add_argument("--static-dir", dest="static_dir", default=str(DEFAULT_STATIC_DIR))
    parser.add_argument("--urdf-path", default=str(DEFAULT_URDF_PATH))
    parser.add_argument("--urdf-root", default=str(DEFAULT_URDF_ROOT))
    parser.add_argument("--urdf-assets-dir", default="ee_assets")
    parser.add_argument("--max-frames", type=int, default=2000)
    parser.add_argument(
        "--results-root",
        default="/pfs/user/open_loop_test/results",
        help="Root containing episode*/horizon*/kai0_viewer_replay.jsonl files for browser switching.",
    )
    args = parser.parse_args()

    static_dir = Path(args.static_dir).expanduser().resolve()
    if not static_dir.exists():
        raise FileNotFoundError(f"static_dir not found: {static_dir}")

    if args.urdf_path:
        urdf_path = Path(args.urdf_path).expanduser().resolve()
        urdf_root = Path(args.urdf_root).expanduser().resolve() if args.urdf_root else None
        _prepare_live_urdf_assets(urdf_path, urdf_root, static_dir / args.urdf_assets_dir)

    server = ThreadingHTTPServer((args.host, args.port), InferViewerHandler)
    server.static_dir = static_dir
    server.max_frames = args.max_frames
    server.results_root = Path(args.results_root).expanduser().resolve() if args.results_root else None
    print(f"Kai0 infer viewer server running at http://{args.host}:{args.port}/?mode=live")
    server.serve_forever()


if __name__ == "__main__":
    main()
