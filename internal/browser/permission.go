package browser

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type BrowserInfo struct {
	Name    string // e.g. "Google Chrome"
	Label   string // e.g. "Chrome"
	Granted bool   // true if Automation permission works
}

// installedBrowsers returns browsers found in /Applications.
var knownBrowsers = []struct{ app, label string }{
	{"Google Chrome", "Chrome"},
	{"Google Chrome Canary", "Chrome Canary"},
	{"Microsoft Edge", "Edge"},
	{"Arc", "Arc"},
	{"Brave Browser", "Brave"},
	{"Vivaldi", "Vivaldi"},
	{"Safari", "Safari"},
	{"Firefox", "Firefox"},
}

// DetectInstalledBrowsers returns which browsers are installed.
func DetectInstalledBrowsers() []BrowserInfo {
	var browsers []BrowserInfo
	for _, b := range knownBrowsers {
		appPath := filepath.Join("/Applications", b.app+".app")
		if _, err := os.Stat(appPath); err == nil {
			browsers = append(browsers, BrowserInfo{
				Name:  b.app,
				Label: b.label,
			})
		}
	}
	return browsers
}

// CheckPermission tests if Randall has Automation access to the given browser.
// Returns true if the AppleScript ran without a permission error.
func CheckPermission(appName string) bool {
	script := `tell application "System Events" to return (exists process "` + appName + `")`
	out, err := exec.Command("osascript", "-e", script).CombinedOutput()
	if err != nil {
		outStr := strings.ToLower(string(out))
		// macOS returns -1743 or "not allowed" when Automation is denied
		if strings.Contains(outStr, "not allowed") ||
			strings.Contains(outStr, "-1743") ||
			strings.Contains(outStr, "assistive") {
			return false
		}
	}
	return true
}

// OpenAutomationSettings opens System Settings → Privacy → Automation pane.
func OpenAutomationSettings() {
	_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation").Run()
}

// RequestPermission triggers the macOS permission prompt for a specific browser
// by attempting a harmless AppleScript call.
func RequestPermission(appName string) {
	script := `tell application "` + appName + `" to return name`
	_ = exec.Command("osascript", "-e", script).Run()
}

// OpenScreenRecordingSettings opens System Settings → Privacy → Screen Recording.
func OpenScreenRecordingSettings() {
	_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").Run()
}

// OpenMicrophoneSettings opens System Settings → Privacy → Microphone.
func OpenMicrophoneSettings() {
	_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone").Run()
}
