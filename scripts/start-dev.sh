#!/usr/bin/env bash
# VinkoClaw 服务启动脚本
# 启动 orchestrator + task-runner，均在 tmux 中自动重启
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo "[vinkoclaw] 启动服务..."

# 杀掉旧 session（如果存在）
tmux kill-session -t vinko-orchestrator 2>/dev/null || true
tmux kill-session -t vinko-runner 2>/dev/null || true

# 启动 orchestrator
tmux new-session -d -s vinko-orchestrator -c "$ROOT" \
  'npm run dev:orchestrator 2>&1 | tee /tmp/vinkoclaw-orchestrator.log'

# 启动 task-runner（带自动重启）
tmux new-session -d -s vinko-runner -c "$ROOT" \
  'node ./scripts/run-task-runners.mjs dev 2>&1 | tee /tmp/vinkoclaw-runner.log'

sleep 2

echo "[vinkoclaw] 服务已启动："
tmux list-sessions
echo ""
echo "  orchestrator 日志: tail -f /tmp/vinkoclaw-orchestrator.log"
echo "  runner 日志:       tail -f /tmp/vinkoclaw-runner.log"
echo "  健康检查:          curl http://localhost:8098/health"
