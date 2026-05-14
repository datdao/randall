package browser

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

type MeetingTab struct {
	Title    string
	URL      string
	Browser  string
	WindowID int
}

var meetingPatterns = []string{
	// Google Meet
	"meet.google.com",
	// Zoom
	"zoom.us/j/",
	"zoom.us/wc/",
	"zoom.us/my/",
	"zoom.us/s/",
	"app.zoom.us",
	// Microsoft Teams
	"teams.microsoft.com",
	"teams.live.com",
	// Cisco Webex
	"webex.com/meet",
	"webex.com/join",
	// Others
	"whereby.com",
	"gather.town",
	"app.gather.town",
	"around.co",
	"tuple.app",
	"pop.com",
	"discord.com/channels",
	"slack.com/call",
	"meet.jit.si",
	"app.livestorm.co",
	"streamyard.com",
	"riverside.fm",
	"cal.com/video",
	"app.daily.co",
	"vdo.ninja",
	"loom.com/share",
}

func isMeetingURL(url string) bool {
	lower := strings.ToLower(url)
	for _, p := range meetingPatterns {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

// titleMeetingKeywords are specific phrases that indicate an active meeting.
// Used only for Firefox where tab URLs aren't accessible.
var titleMeetingKeywords = []string{
	"google meet", "zoom meeting", "zoom webinar",
	"microsoft teams", "webex meeting",
	"meeting in progress",
	"jitsi meet",
}

func isMeetingTitle(title string) bool {
	lower := strings.ToLower(title)
	for _, kw := range titleMeetingKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// DetectMeetingTabs scans all supported browsers for meeting-related tabs
// matched by URL patterns or page title keywords.
func DetectMeetingTabs() []MeetingTab {
	var tabs []MeetingTab

	chromium := []struct{ app, label string }{
		{"Google Chrome", "Chrome"},
		{"Google Chrome Canary", "Chrome Canary"},
		{"Microsoft Edge", "Edge"},
		{"Arc", "Arc"},
		{"Brave Browser", "Brave"},
		{"Vivaldi", "Vivaldi"},
	}
	for _, b := range chromium {
		if t, err := detectChromiumTabs(b.app, b.label); err == nil {
			tabs = append(tabs, t...)
		}
	}
	if t, err := detectSafariTabs(); err == nil {
		tabs = append(tabs, t...)
	}
	if t := detectFirefoxWindows(); len(t) > 0 {
		tabs = append(tabs, t...)
	}
	return tabs
}

func detectChromiumTabs(appName, label string) ([]MeetingTab, error) {
	script := fmt.Sprintf(`
tell application "System Events"
	if not (exists process "%s") then return ""
end tell
tell application "%s"
	set output to ""
	repeat with w in windows
		set wid to id of w
		repeat with t in tabs of w
			set tabURL to URL of t
			set tabTitle to title of t
			set output to output & wid & "|||" & tabTitle & "|||" & tabURL & linefeed
		end repeat
	end repeat
	return output
end tell`, appName, appName)
	return parseTabOutput(script, label)
}

func detectSafariTabs() ([]MeetingTab, error) {
	script := `
tell application "System Events"
	if not (exists process "Safari") then return ""
end tell
tell application "Safari"
	set output to ""
	repeat with w in windows
		set wid to id of w
		repeat with t in tabs of w
			set tabURL to URL of t
			set tabTitle to name of t
			set output to output & wid & "|||" & tabTitle & "|||" & tabURL & linefeed
		end repeat
	end repeat
	return output
end tell`
	return parseTabOutput(script, "Safari")
}

func detectFirefoxWindows() []MeetingTab {
	script := `
tell application "System Events"
	if not (exists process "Firefox") then return ""
	set output to ""
	repeat with w in windows of process "Firefox"
		set wTitle to name of w
		set output to output & "0|||" & wTitle & "|||unknown" & linefeed
	end repeat
	return output
end tell`
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return nil
	}
	var tabs []MeetingTab
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|||", 3)
		if len(parts) < 3 {
			continue
		}
		title := strings.TrimSpace(parts[1])
		if isMeetingTitle(title) {
			tabs = append(tabs, MeetingTab{
				Title:   title,
				URL:     "unknown",
				Browser: "Firefox",
			})
		}
	}
	return tabs
}

func parseTabOutput(script, label string) ([]MeetingTab, error) {
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return nil, err
	}
	var tabs []MeetingTab
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|||", 3)
		if len(parts) < 3 {
			continue
		}
		wid, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
		title := strings.TrimSpace(parts[1])
		url := strings.TrimSpace(parts[2])

		if isMeetingURL(url) {
			tabs = append(tabs, MeetingTab{
				Title:    title,
				URL:      url,
				Browser:  label,
				WindowID: wid,
			})
		}
	}
	return tabs, nil
}
