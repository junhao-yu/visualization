#!/usr/bin/env bash
set -euo pipefail

# Start the Kai0 viewer inside the long-running fastwam container.  Replay is
# intentionally not started here: the caller supplies its JSONL through SSH.
CONTAINER="${KAI0_CONTAINER:-fastwam_container}"
VIEW_ROOT="${KAI0_VIEW_ROOT:-/pfs/user/view}"
RESULTS_ROOT="${KAI0_RESULTS_ROOT:-/pfs/user/open_loop_test/results}"
PORT="${KAI0_PORT:-9001}"
LOG_FILE="${KAI0_LOG_FILE:-$VIEW_ROOT/kai0_viewer_container.log}"
FORWARD_PID_FILE="$VIEW_ROOT/.kai0_viewer_forward_${PORT}.pid"
FORWARD_LOG_FILE="${KAI0_FORWARD_LOG_FILE:-$VIEW_ROOT/kai0_viewer_forward_${PORT}.log}"

usage() {
  cat <<'EOF'
用法：
  start_kai0_viewer_in_container.sh [--rebuild|--stop|--status]

默认操作：在 fastwam_container 中后台启动 Kai0 viewer。
打开轨迹页面后，可直接用 Episode 和 Chunk 下拉框切换结果；结果根目录默认是
/pfs/user/open_loop_test/results，可通过 KAI0_RESULTS_ROOT 覆盖。旧版也可继续
通过 SSH 调用 replay_kai0_trajectory.py 并传入 --input。
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ACTION="${1:-start}"
case "$ACTION" in
  start|--rebuild|--stop|--status) ;;
  *) usage >&2; exit 2 ;;
esac

# Prefer direct Docker access, but transparently use sudo on hosts where the
# current account is not in the docker group.
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -n docker inspect "$CONTAINER" >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  DOCKER=(sudo docker)
  "${DOCKER[@]}" inspect "$CONTAINER" >/dev/null 2>&1 || {
    echo "无法访问 Docker 或找不到容器：$CONTAINER" >&2
    echo "请确认容器已启动，并让当前用户获得 Docker 访问权限。" >&2
    exit 1
  }
fi

RUNNING=$("${DOCKER[@]}" inspect -f '{{.State.Running}}' "$CONTAINER")
if [[ "$RUNNING" != "true" ]]; then
  echo "容器未运行：$CONTAINER" >&2
  exit 1
fi

VIEWER_HOST="127.0.0.1"
VIEWER_PORT="$PORT"
NEEDS_FORWARD=0
NETWORK_MODE=$("${DOCKER[@]}" inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")
if [[ "$NETWORK_MODE" != "host" ]]; then
  PORT_MAPPING=$("${DOCKER[@]}" port "$CONTAINER" "${PORT}/tcp" 2>/dev/null | head -n 1 || true)
  if [[ -n "$PORT_MAPPING" ]]; then
    VIEWER_PORT="${PORT_MAPPING##*:}"
  else
    VIEWER_HOST=$("${DOCKER[@]}" inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER")
    if [[ -z "$VIEWER_HOST" ]]; then
      VIEWER_HOST="127.0.0.1"
      echo "警告：容器没有 host 网络或端口映射，且无法读取容器 IP；请手动确认 viewer 地址。" >&2
    else
      NEEDS_FORWARD=1
    fi
  fi
fi

stop_forward() {
  if [[ -f "$FORWARD_PID_FILE" ]]; then
    local forward_pid
    forward_pid="$(<"$FORWARD_PID_FILE")"
    if [[ "$forward_pid" =~ ^[0-9]+$ ]] && kill -0 "$forward_pid" 2>/dev/null; then
      echo "停止 Kai0 viewer 宿主机端口转发（PID: $forward_pid）..."
      kill -TERM "$forward_pid" 2>/dev/null || true
    fi
    rm -f "$FORWARD_PID_FILE"
  fi
}

case "$ACTION" in
  --status)
    "${DOCKER[@]}" exec "$CONTAINER" bash -lc \
      "ss -lntp 2>/dev/null | awk '\$4 ~ /:${PORT}\$/'; pgrep -af 'kai0_viewer_server.py' || true"
    exit 0
    ;;
  --stop)
    "${DOCKER[@]}" exec "$CONTAINER" bash -lc \
      "cd '$VIEW_ROOT' && PYTHON_BIN=python3 ./start_kai0_dual_piper_viewer.sh --stop"
    stop_forward
    exit 0
    ;;
esac

START_ARGS=""
if [[ "$ACTION" == "--rebuild" ]]; then
  START_ARGS=" --rebuild"
fi

echo "正在容器 $CONTAINER 中启动 Kai0 viewer（端口 $PORT）..."
"${DOCKER[@]}" exec -d "$CONTAINER" bash -lc \
  "cd '$VIEW_ROOT' && umask 000 && KAI0_RESULTS_ROOT='$RESULTS_ROOT' PYTHON_BIN=python3 ./start_kai0_dual_piper_viewer.sh$START_ARGS >> '$LOG_FILE' 2>&1"

ready=0
for _ in {1..30}; do
  if "${DOCKER[@]}" exec "$CONTAINER" python3 - "$PORT" <<'PY' >/dev/null 2>&1
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
  then
    ready=1
    break
  fi
  sleep 0.2
done

if [[ "$ready" -ne 1 ]]; then
  echo "viewer 启动失败：容器内 $PORT 的 /api/index 未通过健康检查。" >&2
  echo "最近日志：$LOG_FILE" >&2
  "${DOCKER[@]}" exec "$CONTAINER" bash -lc "tail -n 40 '$LOG_FILE'" >&2 || true
  exit 1
fi

if [[ "$NEEDS_FORWARD" -eq 1 ]]; then
  forward_reusable=0
  if [[ -f "$FORWARD_PID_FILE" ]]; then
    forward_pid="$(<"$FORWARD_PID_FILE")"
    if [[ "$forward_pid" =~ ^[0-9]+$ ]] && kill -0 "$forward_pid" 2>/dev/null; then
      forward_reusable=1
    fi
  fi

  if [[ "$forward_reusable" -eq 0 ]]; then
    if python3 - "$PORT" <<'PY' >/dev/null 2>&1
import socket
import sys

sock = socket.socket()
sock.settimeout(0.2)
try:
    sock.connect(("127.0.0.1", int(sys.argv[1])))
except OSError:
    raise SystemExit(1)
else:
    raise SystemExit(0)
finally:
    sock.close()
PY
    then
      echo "宿主机端口 $PORT 已被其他进程占用，无法建立容器 viewer 转发。" >&2
      echo "请先确认并停止该端口上的旧进程后重试。" >&2
      exit 1
    fi

    nohup python3 "$VIEW_ROOT/forward_kai0_viewer_port.py" \
      --listen-host 127.0.0.1 --listen-port "$PORT" \
      --target-host "$VIEWER_HOST" --target-port "$PORT" \
      >> "$FORWARD_LOG_FILE" 2>&1 &
    forward_pid=$!
    printf '%s\n' "$forward_pid" > "$FORWARD_PID_FILE"
    sleep 0.2
    if ! kill -0 "$forward_pid" 2>/dev/null; then
      echo "宿主机端口转发启动失败，日志：$FORWARD_LOG_FILE" >&2
      rm -f "$FORWARD_PID_FILE"
      exit 1
    fi
  fi
  VIEWER_HOST="127.0.0.1"
  VIEWER_PORT="$PORT"
fi

ready=0
for _ in {1..20}; do
  if python3 - "$VIEWER_HOST" "$VIEWER_PORT" <<'PY' >/dev/null 2>&1
import json
import sys
from urllib.request import urlopen

host, port = sys.argv[1], int(sys.argv[2])
with urlopen(f"http://{host}:{port}/api/index", timeout=1.0) as response:
    payload = json.loads(response.read().decode("utf-8"))
    if response.status != 200 or not isinstance(payload, dict) or not {"meta", "frames", "last_id"} <= payload.keys():
        raise RuntimeError("viewer health check failed")
with urlopen(f"http://{host}:{port}/api/catalog", timeout=1.0) as response:
    payload = json.loads(response.read().decode("utf-8"))
    if response.status != 200 or not isinstance(payload, dict) or "entries" not in payload:
        raise RuntimeError("viewer catalog health check failed")
PY
  then
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "宿主机 viewer 地址健康检查失败：http://${VIEWER_HOST}:${VIEWER_PORT}" >&2
  echo "容器日志：$LOG_FILE" >&2
  exit 1
fi

echo "viewer 已启动，API 健康检查通过。"
echo "服务日志：$LOG_FILE"
echo "viewer 地址：http://${VIEWER_HOST}:${VIEWER_PORT}/ee_viewer/index.html"
echo "回放目标：http://${VIEWER_HOST}:${VIEWER_PORT}（SSH 回放时传给 --viewer-url）"
echo "浏览器切换数据根目录：${RESULTS_ROOT}（Episode / Chunk 下拉框）"
echo "之后可用 SSH 调用 replay_kai0_trajectory.py 并自行指定 --input。"
