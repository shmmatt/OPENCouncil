#!/bin/bash
#
# Install OPENCouncil Document Uploader Service
#
# This script installs a persistent systemd service that watches for
# document upload queues and processes them independently of OpenClaw.
#

set -e

echo "🚀 Installing OPENCouncil Document Uploader Service..."
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ This script must be run with sudo"
  echo "   Usage: sudo bash scripts/install-uploader-service.sh"
  exit 1
fi

# Get actual user (not root)
ACTUAL_USER="${SUDO_USER:-$USER}"
WORKSPACE_DIR="/home/$ACTUAL_USER/.openclaw/workspace/OPENCouncil"

echo "📂 Workspace: $WORKSPACE_DIR"
echo "👤 User: $ACTUAL_USER"
echo ""

# Verify workspace exists
if [ ! -d "$WORKSPACE_DIR" ]; then
  echo "❌ Workspace directory not found: $WORKSPACE_DIR"
  exit 1
fi

# Verify service file exists
SERVICE_FILE="$WORKSPACE_DIR/systemd/opencouncil-uploader.service"
if [ ! -f "$SERVICE_FILE" ]; then
  echo "❌ Service file not found: $SERVICE_FILE"
  exit 1
fi

# Create upload queue directory
UPLOAD_QUEUE_DIR="$WORKSPACE_DIR/upload-queue"
mkdir -p "$UPLOAD_QUEUE_DIR"
chown -R $ACTUAL_USER:$ACTUAL_USER "$UPLOAD_QUEUE_DIR"
echo "✅ Created upload queue directory: $UPLOAD_QUEUE_DIR"

# Create logs directory
LOGS_DIR="$WORKSPACE_DIR/logs"
mkdir -p "$LOGS_DIR"
chown -R $ACTUAL_USER:$ACTUAL_USER "$LOGS_DIR"
echo "✅ Created logs directory: $LOGS_DIR"

# Install systemd service
echo "📦 Installing systemd service..."
cp "$SERVICE_FILE" /etc/systemd/system/opencouncil-uploader.service

# Reload systemd
systemctl daemon-reload

# Enable service (start on boot)
systemctl enable opencouncil-uploader.service

# Start service
systemctl start opencouncil-uploader.service

echo ""
echo "✅ Service installed and started!"
echo ""
echo "📋 Useful commands:"
echo "   sudo systemctl status opencouncil-uploader   # Check status"
echo "   sudo systemctl stop opencouncil-uploader     # Stop service"
echo "   sudo systemctl start opencouncil-uploader    # Start service"
echo "   sudo systemctl restart opencouncil-uploader  # Restart service"
echo "   sudo journalctl -u opencouncil-uploader -f   # View live logs"
echo "   tail -f $LOGS_DIR/uploader-service.log       # View service log file"
echo ""
echo "🎯 The service will watch: $UPLOAD_QUEUE_DIR"
echo "   Drop JSON files there and they'll be uploaded automatically"
echo ""
