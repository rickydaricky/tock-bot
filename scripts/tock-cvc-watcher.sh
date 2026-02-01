#!/bin/bash
# Tock CVC Auto-Trigger Watcher
#
# This script monitors for a trigger file and automatically runs the CVC automation.
# The Chrome extension will create the trigger file when the purchase page is ready.
#
# Usage:
#   ./tock-cvc-watcher.sh        # Start watching
#   ./tock-cvc-watcher.sh stop   # Stop watching
#
# The script watches for: /tmp/tock-cvc-trigger
# When the file appears, it runs the CVC automation and deletes the trigger.

TRIGGER_FILE="/tmp/tock-cvc-trigger"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="/tmp/tock-cvc-watcher.pid"

# Handle stop command
if [ "$1" == "stop" ]; then
    if [ -f "$PID_FILE" ]; then
        kill $(cat "$PID_FILE") 2>/dev/null
        rm -f "$PID_FILE"
        echo "Watcher stopped"
    else
        echo "Watcher not running"
    fi
    exit 0
fi

# Check if already running
if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo "Watcher already running (PID: $(cat $PID_FILE))"
    exit 1
fi

# Save PID
echo $$ > "$PID_FILE"

echo "Starting Tock CVC Watcher..."
echo "Monitoring for trigger file: $TRIGGER_FILE"
echo "Press Ctrl+C to stop"

# Cleanup on exit
cleanup() {
    rm -f "$PID_FILE"
    rm -f "$TRIGGER_FILE"
    echo "Watcher stopped"
    exit 0
}
trap cleanup INT TERM

# Main loop
while true; do
    if [ -f "$TRIGGER_FILE" ]; then
        echo "$(date): Trigger detected! Running CVC automation..."

        # Read any coordinates from the trigger file (optional)
        COORDS=$(cat "$TRIGGER_FILE" 2>/dev/null)

        # Remove trigger file
        rm -f "$TRIGGER_FILE"

        # Small delay to ensure Chrome is ready
        sleep 0.3

        # Run the AppleScript
        osascript "$SCRIPT_DIR/tock-cvc-automation.applescript"

        echo "$(date): CVC automation completed"
    fi
    sleep 0.2
done
