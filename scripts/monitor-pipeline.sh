#!/bin/bash
# Monitor the pipeline batch crawl

SOCKET_DIR="${TMPDIR:-/tmp}/openclaw-tmux-sockets"
SOCKET="$SOCKET_DIR/openclaw.sock"
SESSION=pipeline-batch-crawl

echo "========================================"
echo "🔍 Pipeline Monitor"
echo "========================================"
echo ""

# Check if session exists
if ! tmux -S "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
    echo "❌ No pipeline session running"
    echo ""
    echo "Latest log files:"
    ls -lth /home/ubuntu/.openclaw/workspace/OPENCouncil/logs/batch-crawl-*.log 2>/dev/null | head -5
    exit 1
fi

echo "✅ Session active: $SESSION"
echo ""
echo "📊 Recent output (last 50 lines):"
echo "----------------------------------------"
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -50
echo "----------------------------------------"
echo ""
echo "💡 Commands:"
echo "   Watch live:  tmux -S '$SOCKET' attach -t '$SESSION'"
echo "   Detach:      Ctrl+b d"
echo "   Kill:        tmux -S '$SOCKET' kill-session -t '$SESSION'"
echo ""
echo "📁 Log file:   logs/batch-crawl-*.log"
echo ""
