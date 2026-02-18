#!/bin/bash
# Monitor the download worker

SOCKET_DIR="${TMPDIR:-/tmp}/openclaw-tmux-sockets"
SOCKET="$SOCKET_DIR/openclaw.sock"
SESSION=pipeline-download-worker

echo "========================================"
echo "📥 Download Worker Monitor"
echo "========================================"
echo ""

# Check if session exists
if ! tmux -S "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
    echo "❌ No download worker session running"
    echo ""
    echo "Latest log files:"
    ls -lth /home/ubuntu/.openclaw/workspace/OPENCouncil/logs/download-worker-*.log 2>/dev/null | head -3
    exit 1
fi

echo "✅ Session active: $SESSION"
echo ""
echo "📊 Recent output (last 60 lines):"
echo "----------------------------------------"
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -60
echo "----------------------------------------"
echo ""
echo "💡 Commands:"
echo "   Watch live:  tmux -S '$SOCKET' attach -t '$SESSION'"
echo "   Detach:      Ctrl+b d"
echo "   Kill:        tmux -S '$SOCKET' kill-session -t '$SESSION'"
echo ""
echo "📁 Log file:   logs/download-worker-*.log"
echo ""
