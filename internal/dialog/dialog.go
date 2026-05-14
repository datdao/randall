package dialog

import (
	"fmt"
	"os/exec"
	"strings"
)

// InputDialog shows a native macOS text input dialog and returns the user's input.
func InputDialog(title, message, defaultValue string) (string, bool) {
	script := fmt.Sprintf(`
set result to display dialog %q default answer %q with title %q buttons {"Cancel", "OK"} default button "OK"
return text returned of result`, message, defaultValue, title)

	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// ChooseFolder shows a native macOS folder picker and returns the selected path.
func ChooseFolder(prompt string) (string, bool) {
	script := fmt.Sprintf(`
set chosenFolder to choose folder with prompt %q
return POSIX path of chosenFolder`, prompt)

	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// Notify sends a macOS notification.
func Notify(title, message string) {
	script := fmt.Sprintf(`display notification %q with title %q`, message, title)
	_ = exec.Command("osascript", "-e", script).Run()
}

// Alert shows a simple alert dialog.
func Alert(title, message string) {
	script := fmt.Sprintf(`display alert %q message %q`, title, message)
	_ = exec.Command("osascript", "-e", script).Run()
}

// OpenFolder opens a folder in Finder.
func OpenFolder(path string) {
	_ = exec.Command("open", path).Run()
}

// OpenFile opens a file with the default application.
func OpenFile(path string) {
	_ = exec.Command("open", path).Run()
}
