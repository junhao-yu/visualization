#!/usr/bin/env bash
set -euo pipefail

VIEW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python}"
PORT="${PORT:-9001}"
URDF="${URDF:-/pfs/user/rm-wam/assets/dual_piper/dual_system.urdf}"
RESULTS_ROOT="${KAI0_RESULTS_ROOT:-/pfs/user/open_loop_test/results}"
STATIC_DIR="$VIEW_ROOT/kai0_dual_piper_viewer"
PID_FILE="$VIEW_ROOT/.kai0_viewer_${PORT}.pid"
SERVER_PID=""

show_port_owner_and_exit() {
  local listeners
  listeners="$(ss -lntp 2>/dev/null | awk -v port=":${PORT}" '$4 ~ (port "$") { print }')"
  if [[ -n "$listeners" ]]; then
    echo "端口 $PORT 已被占用，无法启动新的 Viewer：" >&2
    echo "$listeners" >&2
    echo "若是本工具的遗留服务，可执行：$0 --stop" >&2
    echo "若不是本工具的服务，请先在对应环境中停止该服务。" >&2
    exit 1
  fi
}

viewer_is_healthy() {
  "$PYTHON_BIN" - "$PORT" <<'PY' >/dev/null 2>&1
import json
import sys
from urllib.request import urlopen

port = int(sys.argv[1])
with urlopen(f"http://127.0.0.1:{port}/api/index", timeout=1.0) as response:
    if response.status != 200:
        raise RuntimeError(f"unexpected HTTP status: {response.status}")
    payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict) or not {"meta", "frames", "last_id"} <= payload.keys():
        raise RuntimeError("viewer returned an invalid index response")
with urlopen(f"http://127.0.0.1:{port}/api/catalog", timeout=1.0) as response:
    payload = json.loads(response.read().decode("utf-8"))
    if response.status != 200 or not isinstance(payload, dict) or "entries" not in payload:
        raise RuntimeError("viewer returned an invalid catalog response")
PY
}

stop_owned_servers() {
  local matching_pid process_args
  local found=0

  while IFS=' ' read -r matching_pid process_args; do
    [[ -z "$matching_pid" ]] && continue
    [[ "$process_args" != *"$VIEW_ROOT/kai0_viewer_server.py"* ]] && continue
    [[ "$process_args" != *"--port $PORT"* ]] && continue
    found=1
    echo "停止 Kai0 viewer 进程：$matching_pid"
    kill -TERM "$matching_pid" 2>/dev/null || true
  done < <(ps -eo pid=,args=)

  rm -f "$PID_FILE"
  if [[ "$found" -eq 0 ]]; then
    echo "没有发现端口 $PORT 上由本工具启动的 Kai0 viewer 进程。"
  fi
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM

  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo
    echo "正在停止本次启动的 Kai0 viewer（PID: $SERVER_PID）..."
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  exit "$exit_status"
}

case "${1:-}" in
  --stop)
    stop_owned_servers
    exit 0
    ;;
  ""|--rebuild)
    ;;
  *)
    echo "用法：$0 [--rebuild|--stop]" >&2
    exit 2
    ;;
esac

if [[ "${1:-}" == "--rebuild" ]]; then
  echo "[1/2] 正在重新准备双 Piper 的浏览器 3D 模型..."
  "$PYTHON_BIN" "$VIEW_ROOT/prepare_kai0_robot_viewer.py" \
    --urdf "$URDF" --out "$STATIC_DIR" --force
elif [[ ! -f "$STATIC_DIR/ee_assets/robot.urdf" ]]; then
  echo "[1/2] 首次运行：正在准备双 Piper 的浏览器 3D 模型..."
  "$PYTHON_BIN" "$VIEW_ROOT/prepare_kai0_robot_viewer.py" \
    --urdf "$URDF" --out "$STATIC_DIR"
else
  echo "[1/2] 已找到双 Piper 3D 模型，跳过准备步骤。"
fi

if ss -lnt 2>/dev/null | awk -v port=":${PORT}" '$4 ~ (port "$") { found = 1 } END { exit !found }'; then
  if viewer_is_healthy; then
    echo "Kai0 viewer 已在端口 $PORT 运行，API 健康检查通过。"
    exit 0
  fi

  # A previous Kai0 process can keep the port while no longer serving HTTP.
  # Reclaim only processes owned by this viewer script; unrelated listeners
  # remain protected by show_port_owner_and_exit below.
  echo "发现失效的 Kai0 viewer，正在停止旧进程并重新启动..." >&2
  stop_owned_servers
  for _ in {1..20}; do
    if ss -lnt 2>/dev/null | awk -v port=":${PORT}" '$4 ~ (port "$") { found = 1 } END { exit found }'; then
      sleep 0.1
    else
      break
    fi
  done
fi

show_port_owner_and_exit

echo "[2/2] 正在启动 Kai0 浏览器 3D viewer，端口：$PORT"
echo "浏览器地址：http://127.0.0.1:${PORT}/ee_viewer/index.html"
echo "浏览器可通过 Episode / Chunk 下拉框切换结果（数据根目录：${RESULTS_ROOT}）。"
echo "保持此终端运行；另开终端执行 replay_kai0_trajectory.sh 加载轨迹。"
echo "按 Ctrl+C 将自动关闭本次启动的服务。"

trap cleanup EXIT INT TERM
"$PYTHON_BIN" "$VIEW_ROOT/kai0_viewer_server.py" \
  --host 0.0.0.0 --port "$PORT" --static-dir "$STATIC_DIR" --urdf-path "" \
  --results-root "$RESULTS_ROOT" &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"
wait "$SERVER_PID"
