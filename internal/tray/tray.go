package tray

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/getlantern/systray"

	"randall/internal/browser"
	"randall/internal/config"
	"randall/internal/dialog"
	"randall/internal/recorder"
)

const maxSlots = 10

type meetingSlot struct {
	parent *systray.MenuItem
	start  *systray.MenuItem
	pause  *systray.MenuItem
	stop   *systray.MenuItem
	tab    *browser.MeetingTab
	rec    *recorder.Recorder
	title  string // track current base title
}

type Tray struct {
	cfg   *config.Config
	mu    sync.Mutex
	slots [maxSlots]*meetingSlot
	icon  []byte
	rIcon []byte
}

func Run(cfg *config.Config) {
	t := &Tray{
		cfg:   cfg,
		icon:  genIcon(),
		rIcon: genRecordingIcon(),
	}
	systray.Run(t.onReady, t.onExit)
}

func (t *Tray) onReady() {
	systray.SetTemplateIcon(t.icon, t.icon)
	systray.SetTooltip("Randall – Meeting Recorder")

	// Trigger browser permission prompts on first launch
	go t.checkBrowserPermissions()

	// Header
	mTitle := systray.AddMenuItem("Randall Recorder", "")
	mTitle.Disable()
	systray.AddSeparator()

	// Meeting slots
	for i := 0; i < maxSlots; i++ {
		s := &meetingSlot{}
		s.parent = systray.AddMenuItem("", "")
		s.start = s.parent.AddSubMenuItem("▶  Start Recording", "")
		s.pause = s.parent.AddSubMenuItem("⏸  Pause", "")
		s.stop = s.parent.AddSubMenuItem("⏹  Stop", "")
		s.parent.Hide()
		s.pause.Hide()
		s.stop.Hide()
		t.slots[i] = s
		go t.slotLoop(i)
	}

	mNoMeetings := systray.AddMenuItem("Scanning…", "")
	mNoMeetings.Disable()

	systray.AddSeparator()

	// Settings
	mSettings := systray.AddMenuItem("⚙  Settings", "")
	mResolution := mSettings.AddSubMenuItem(
		fmt.Sprintf("Resolution: %dx%d", t.cfg.Width, t.cfg.Height), "")
	mFPS := mSettings.AddSubMenuItem(
		fmt.Sprintf("FPS: %d", t.cfg.FPS), "")
	mOutputDir := mSettings.AddSubMenuItem(
		fmt.Sprintf("Folder: %s", shortPath(t.cfg.OutputDir)), "")
	// Audio device chooser
	const maxAudioSlots = 10
	mAudioParent := mSettings.AddSubMenuItem(t.audioParentLabel(), "Choose audio input device")
	mAudioOff := mAudioParent.AddSubMenuItem("  Off (no audio)", "")
	mAudioAuto := mAudioParent.AddSubMenuItem("  Auto-detect", "")
	type audioSlot struct {
		item *systray.MenuItem
		name string
	}
	audioSlots := make([]audioSlot, maxAudioSlots)
	for i := 0; i < maxAudioSlots; i++ {
		audioSlots[i].item = mAudioParent.AddSubMenuItem("", "")
		audioSlots[i].item.Hide()
	}

	updateAudioMenu := func() {
		devices := recorder.ListAudioDevices()
		cur := t.cfg.AudioDevice

		// Update checkmarks on fixed items
		if cur == "" {
			mAudioOff.SetTitle("✓ Off (no audio)")
		} else {
			mAudioOff.SetTitle("  Off (no audio)")
		}
		if cur == "auto" {
			mAudioAuto.SetTitle("✓ Auto-detect")
		} else {
			mAudioAuto.SetTitle("  Auto-detect")
		}

		for i := 0; i < maxAudioSlots; i++ {
			if i < len(devices) {
				d := devices[i]
				audioSlots[i].name = d.Name
				prefix := "  "
				if cur == d.Name {
					prefix = "✓ "
				}
				audioSlots[i].item.SetTitle(prefix + d.Name)
				audioSlots[i].item.Show()
			} else {
				audioSlots[i].item.Hide()
				audioSlots[i].name = ""
			}
		}
		mAudioParent.SetTitle(t.audioParentLabel())
	}
	updateAudioMenu()

	// Audio device click handlers
	go func() {
		for range mAudioOff.ClickedCh {
			t.cfg.AudioDevice = ""
			_ = t.cfg.Save()
			updateAudioMenu()
		}
	}()
	go func() {
		for range mAudioAuto.ClickedCh {
			t.cfg.AudioDevice = "auto"
			_ = t.cfg.Save()
			updateAudioMenu()
		}
	}()
	for i := 0; i < maxAudioSlots; i++ {
		i := i
		go func() {
			for range audioSlots[i].item.ClickedCh {
				if audioSlots[i].name != "" {
					t.cfg.AudioDevice = audioSlots[i].name
					_ = t.cfg.Save()
					updateAudioMenu()
				}
			}
		}()
	}

	mOpenFolder := mSettings.AddSubMenuItem("Open Output Folder", "")
	mEditConfig := mSettings.AddSubMenuItem("Edit Config File", "")
	// Permissions submenu inside Settings
	mPerms := mSettings.AddSubMenuItem("🔐 Permissions", "")
	mScreenPerm := mPerms.AddSubMenuItem("🛡 Screen Recording…", "Required for recording")
	mMicPerm := mPerms.AddSubMenuItem("🎤 Microphone…", "Required for audio recording")
	mBrowserPerm := mPerms.AddSubMenuItem("🌐 Browser Automation…", "Required to detect meeting tabs")

	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "")

	// Refresh meetings immediately and every 10s
	refreshMeetings := func() {
		tabs := browser.DetectMeetingTabs()
		t.mu.Lock()
		defer t.mu.Unlock()

		for i := 0; i < maxSlots; i++ {
			if i < len(tabs) {
				tab := tabs[i]
				t.slots[i].tab = &tab
				label := truncate(tab.Title, 50)
				if t.slots[i].rec != nil && t.slots[i].rec.State() != recorder.Idle {
					switch t.slots[i].rec.State() {
					case recorder.Recording:
						label = "🔴 " + label
					case recorder.Paused:
						label = "⏸ " + label
					}
				}
				t.slots[i].parent.SetTitle(label)
				t.slots[i].parent.Show()
			} else {
				t.slots[i].parent.Hide()
				t.slots[i].tab = nil
			}
		}
		if len(tabs) > 0 {
			mNoMeetings.Hide()
		} else {
			mNoMeetings.Show()
		}
	}

	go func() {
		refreshMeetings()
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			refreshMeetings()
		}
	}()

	// Settings handlers
	go func() {
		for range mResolution.ClickedCh {
			current := fmt.Sprintf("%dx%d", t.cfg.Width, t.cfg.Height)
			val, ok := dialog.InputDialog("Resolution", "Enter resolution (WxH):", current)
			if !ok {
				continue
			}
			parts := strings.SplitN(val, "x", 2)
			if len(parts) == 2 {
				w, e1 := strconv.Atoi(strings.TrimSpace(parts[0]))
				h, e2 := strconv.Atoi(strings.TrimSpace(parts[1]))
				if e1 == nil && e2 == nil && w > 0 && h > 0 {
					t.cfg.Width = w
					t.cfg.Height = h
					_ = t.cfg.Save()
					mResolution.SetTitle(fmt.Sprintf("Resolution: %dx%d", w, h))
				}
			}
		}
	}()
	go func() {
		for range mFPS.ClickedCh {
			val, ok := dialog.InputDialog("Frame Rate", "Enter FPS:", strconv.Itoa(t.cfg.FPS))
			if !ok {
				continue
			}
			fps, err := strconv.Atoi(strings.TrimSpace(val))
			if err == nil && fps > 0 && fps <= 120 {
				t.cfg.FPS = fps
				_ = t.cfg.Save()
				mFPS.SetTitle(fmt.Sprintf("FPS: %d", fps))
			}
		}
	}()
	go func() {
		for range mOutputDir.ClickedCh {
			folder, ok := dialog.ChooseFolder("Select output folder for recordings:")
			if ok {
				t.cfg.OutputDir = folder
				_ = t.cfg.Save()
				mOutputDir.SetTitle(fmt.Sprintf("Folder: %s", shortPath(folder)))
			}
		}
	}()
	go func() {
		for range mOpenFolder.ClickedCh {
			_ = os.MkdirAll(t.cfg.OutputDir, 0755)
			dialog.OpenFolder(t.cfg.OutputDir)
		}
	}()
	go func() {
		for range mScreenPerm.ClickedCh {
			browser.OpenScreenRecordingSettings()
		}
	}()
	go func() {
		for range mMicPerm.ClickedCh {
			browser.OpenMicrophoneSettings()
		}
	}()
	go func() {
		for range mBrowserPerm.ClickedCh {
			browser.OpenAutomationSettings()
		}
	}()
	go func() {
		for range mEditConfig.ClickedCh {
			dialog.OpenFile(config.ConfigPath())
		}
	}()

	go func() {
		<-mQuit.ClickedCh
		t.stopAll()
		systray.Quit()
	}()
}

func (t *Tray) onExit() {
	t.stopAll()
}

func (t *Tray) stopAll() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, s := range t.slots {
		if s != nil && s.rec != nil && s.rec.State() != recorder.Idle {
			_, _ = s.rec.Stop()
		}
	}
}

func (t *Tray) slotLoop(idx int) {
	s := t.slots[idx]
	for {
		select {
		case <-s.start.ClickedCh:
			t.handleStart(idx)
		case <-s.pause.ClickedCh:
			t.handlePause(idx)
		case <-s.stop.ClickedCh:
			t.handleStop(idx)
		}
	}
}

func (t *Tray) handleStart(idx int) {
	s := t.slots[idx]
	if s.tab == nil {
		return
	}

	// If screen recording permission hasn't been granted yet, trigger the
	// native macOS dialog and bail out silently — no redundant error alert.
	if !recorder.HasScreenCapturePermission() {
		recorder.RequestScreenCapturePermission()
		return
	}

	s.rec = recorder.New(t.cfg)
	if err := s.rec.Start(); err != nil {
		dialog.Alert("Recording Error", err.Error())
		return
	}

	s.start.Hide()
	s.pause.Show()
	s.stop.Show()
	s.title = truncate(s.tab.Title, 50)
	s.parent.SetTitle("🔴 " + s.title)
	systray.SetIcon(t.rIcon)
	dialog.Notify("Recording Started", s.tab.Title)
}

func (t *Tray) handlePause(idx int) {
	s := t.slots[idx]
	if s.rec == nil {
		return
	}

	switch s.rec.State() {
	case recorder.Recording:
		if err := s.rec.Pause(); err != nil {
			log.Printf("pause error: %v", err)
			return
		}
		s.pause.SetTitle("▶  Resume")
		s.parent.SetTitle("⏸ " + s.title)
		dialog.Notify("Recording Paused", s.tab.Title)

	case recorder.Paused:
		if err := s.rec.Resume(); err != nil {
			log.Printf("resume error: %v", err)
			return
		}
		s.pause.SetTitle("⏸  Pause")
		s.parent.SetTitle("🔴 " + s.title)
		dialog.Notify("Recording Resumed", s.tab.Title)
	}
}

func (t *Tray) handleStop(idx int) {
	s := t.slots[idx]
	if s.rec == nil {
		return
	}

	outPath, err := s.rec.Stop()
	if err != nil {
		dialog.Alert("Stop Error", err.Error())
		return
	}

	systray.SetTemplateIcon(t.icon, t.icon)

	// Ask user to rename
	dir := filepath.Dir(outPath)
	base := strings.TrimSuffix(filepath.Base(outPath), filepath.Ext(outPath))
	newName, ok := dialog.InputDialog("Save Recording",
		"Enter filename for the recording:", base)
	if ok && newName != "" && newName != base {
		newPath := filepath.Join(dir, newName+".mov")
		if err := os.Rename(outPath, newPath); err == nil {
			outPath = newPath
		}
	}

	// Reset UI
	s.start.Show()
	s.pause.SetTitle("⏸  Pause")
	s.pause.Hide()
	s.stop.Hide()
	if s.tab != nil {
		s.parent.SetTitle(truncate(s.tab.Title, 50))
	}

	dialog.Notify("Recording Saved", filepath.Base(outPath))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func shortPath(p string) string {
	home, _ := os.UserHomeDir()
	if strings.HasPrefix(p, home) {
		return "~" + p[len(home):]
	}
	return p
}

// checkBrowserPermissions detects installed browsers and triggers macOS
// Automation permission prompts only for browsers not yet granted.
// Uses native macOS API (osascript) to check — no flag files.
func (t *Tray) checkBrowserPermissions() {
	installed := browser.DetectInstalledBrowsers()

	var denied []string
	for _, b := range installed {
		if !browser.CheckPermission(b.Name) {
			denied = append(denied, b.Label)
			browser.RequestPermission(b.Name)
		}
	}
	if len(denied) > 0 {
		msg := "Randall needs Automation access to detect meeting tabs.\n\n"
		msg += "Please allow access for: " + strings.Join(denied, ", ") + "\n\n"
		msg += "If you dismissed the prompt, go to:\nSettings → Privacy → Automation"
		dialog.Alert("Browser Permissions", msg)
	}
}

func (t *Tray) audioParentLabel() string {
	switch t.cfg.AudioDevice {
	case "":
		return "🔇 Audio: Off"
	case "auto":
		return "🔊 Audio: Auto"
	default:
		return "🔊 Audio: " + truncate(t.cfg.AudioDevice, 25)
	}
}
