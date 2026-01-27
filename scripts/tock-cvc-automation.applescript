(*
  Tock CVC Automation Script

  This script automates entering the CVC code on Tock checkout pages.

  SETUP:
  1. Edit tock-cvc-config.json in the same folder and set your CVC
  2. Grant Accessibility permissions to Script Editor/osascript:
     System Settings > Privacy & Security > Accessibility

  USAGE:
  When you see the orange-highlighted CVC field:
  - Press your configured keyboard shortcut, OR
  - Run this script from Script Editor

  TO CREATE A KEYBOARD SHORTCUT:
  1. Open Automator > File > New > Quick Action
  2. Set "Workflow receives" to "no input"
  3. Search for "Run AppleScript" and drag it in
  4. Paste this entire script
  5. Save as "Tock CVC"
  6. Go to System Settings > Keyboard > Keyboard Shortcuts > Services
  7. Find "Tock CVC" and assign a shortcut (e.g., Cmd+Shift+V)
*)

-- Configuration
property configPath : "/Users/rzhon/code/rickydaricky/tock-bot/scripts/tock-cvc-config.json"

-- Read CVC from config file
on readCVCFromConfig()
	try
		set configContent to do shell script "cat " & quoted form of configPath
		set cvcValue to do shell script "echo " & quoted form of configContent & " | /usr/bin/python3 -c \"import sys, json; print(json.load(sys.stdin)['cvc'])\""

		if cvcValue is "YOUR_CVC_HERE" or cvcValue is "" then
			display alert "CVC Not Configured" message "Please edit tock-cvc-config.json and set your CVC code." as warning
			return ""
		end if

		return cvcValue
	on error errMsg
		display alert "Config Error" message "Could not read CVC config: " & errMsg as critical
		return ""
	end try
end readCVCFromConfig

-- Click at specific screen coordinates using cliclick or mouse movement
on clickAtPosition(x, y)
	try
		-- Try using cliclick if installed (brew install cliclick)
		do shell script "/opt/homebrew/bin/cliclick c:" & x & "," & y
		return true
	on error
		try
			-- Fallback: Use Python to move and click
			do shell script "/usr/bin/python3 -c \"
import Quartz
from Quartz import CGEventCreateMouseEvent, kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGMouseButtonLeft, CGEventPost, kCGHIDEventTap

x, y = " & x & ", " & y & "
event = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, (x, y), kCGMouseButtonLeft)
CGEventPost(kCGHIDEventTap, event)
event = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, (x, y), kCGMouseButtonLeft)
CGEventPost(kCGHIDEventTap, event)
\""
			return true
		on error
			return false
		end try
	end try
end clickAtPosition

-- Main automation
on run
	-- Read CVC from config
	set cvcCode to readCVCFromConfig()
	if cvcCode is "" then return

	-- Activate Chrome
	tell application "Google Chrome"
		activate
	end tell

	delay 0.2

	tell application "System Events"
		tell process "Google Chrome"
			set frontmost to true
			delay 0.1

			-- Get window position and size
			try
				set winPosition to position of window 1
				set winSize to size of window 1
				set winX to item 1 of winPosition
				set winY to item 2 of winPosition
				set winWidth to item 1 of winSize
				set winHeight to item 2 of winSize

				-- CVC field position (adjust these percentages if needed)
				-- These work for standard Tock checkout layout
				set clickX to round (winX + (winWidth * 0.55))
				set clickY to round (winY + (winHeight * 0.52))

				-- Click the CVC field
				my clickAtPosition(clickX, clickY)
				delay 0.3

			on error errMsg
				-- If we can't get position, assume user clicked the field already
				log "Could not get window position: " & errMsg
			end try

			-- Type the CVC
			keystroke cvcCode
			delay 0.2

			-- Press Enter
			keystroke return

		end tell
	end tell

	display notification "CVC entered!" with title "Tock Automation"
end run
