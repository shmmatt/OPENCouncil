#!/bin/bash
# Monitor the ingestion worker

SOCKET_DIR="${TMPDIR:-/tmp}/openclaw-tmux-sockets"
SOCKET="$SOCKET_DIR/openclaw.sock"
SESSION=pipeline-ingestion-worker

echo "========================================"
echo "📥 Ingestion Worker Monitor"
echo "========================================"
echo ""

# Check if session exists
if ! tmux -S "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
    echo "❌ No ingestion worker session running"
    echo ""
    echo "Latest log files:"
    ls -lth /home/ubuntu/.openclaw/workspace/OPENCouncil/logs/ingestion-worker-*.log 2>/dev/null | head -3
    exit 1
fi

echo "✅ Session active: $SESSION"
echo ""

# Get database status
cd /home/ubuntu/.openclaw/workspace/OPENCouncil
node -r dotenv/config ./node_modules/.bin/tsx scripts/check-ingestion-status.ts 2>&1

echo ""
echo "📊 Recent output (last 40 lines):"
echo "----------------------------------------"
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -40
echo "----------------------------------------"
echo ""
echo "💡 Commands:"
echo "   Watch live:  tmux -S '$SOCKET' attach -t '$SESSION'"
echo "   Detach:      Ctrl+b d"
echo "   Kill:        tmux -S '$SOCKET' kill-session -t '$SESSION'"
echo ""
echo "📁 Log file:   logs/ingestion-worker-*.log"
echo ""
