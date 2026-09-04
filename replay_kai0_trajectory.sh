#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：$0 /path/to/kai0_viewer_replay.jsonl" >&2
  exit 2
fi

VIEW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python}"
INPUT="$1"
TARGET_VIEWER_URL="${VIEWER_URL:-http://127.0.0.1:9001}"

if [[ ! -f "$INPUT" ]]; then
  echo "找不到轨迹回放文件：$INPUT" >&2
  exit 2
fi

echo "正在清空浏览器中的旧轨迹..."
echo "正在加载：$INPUT"
echo "推送目标：$TARGET_VIEWER_URL"
"$PYTHON_BIN" "$VIEW_ROOT/replay_kai0_trajectory.py" \
  --input "$INPUT" --viewer-url "$TARGET_VIEWER_URL" --reset-first
echo "加载完成。浏览器中拖动时间滑块即可查看预测与 GT 轨迹。"
