#!/bin/bash
# Tock CVC Automation Shell Script
#
# This script runs the AppleScript to enter CVC on Tock checkout pages.
#
# Usage: ./tock-cvc.sh
#
# Setup:
# 1. chmod +x tock-cvc.sh
# 2. Edit tock-cvc-config.json with your CVC
# 3. Run when you see the orange-highlighted CVC field

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
osascript "$SCRIPT_DIR/tock-cvc-automation.applescript"
