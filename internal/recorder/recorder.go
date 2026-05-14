package recorder

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"randall/internal/config"
)

type State int

const (
	Idle State = iota
	Recording
	Paused
)

type Recorder struct {
	cfg      *config.Config
	mu       sync.Mutex
	state    State
	sckID    int // ScreenCaptureKit recorder ID
	segments []string
	tempDir  string
	started  time.Time
}

func New(cfg *config.Config) *Recorder {
	return &Recorder{cfg: cfg, state: Idle}
}

func (r *Recorder) State() State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

func (r *Recorder) Start() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.state != Idle {
		return fmt.Errorf("recorder is not idle (state=%d)", r.state)
	}

	if err := os.MkdirAll(r.cfg.OutputDir, 0755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}

	tmp, err := os.MkdirTemp("", "randall-rec-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	r.tempDir = tmp
	r.segments = nil
	r.started = time.Now()

	if err := r.startSegment(); err != nil {
		return err
	}
	r.state = Recording
	return nil
}

func (r *Recorder) Pause() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.state != Recording {
		return fmt.Errorf("not recording")
	}
	if err := r.stopSegment(); err != nil {
		return err
	}
	r.state = Paused
	return nil
}

func (r *Recorder) Resume() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.state != Paused {
		return fmt.Errorf("not paused")
	}
	if err := r.startSegment(); err != nil {
		return err
	}
	r.state = Recording
	return nil
}

// Stop ends the recording and returns the final file path.
func (r *Recorder) Stop() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.state == Idle {
		return "", fmt.Errorf("not recording")
	}
	if r.state == Recording {
		if err := r.stopSegment(); err != nil {
			return "", err
		}
	}

	ts := r.started.Format("2006-01-02_15-04-05")
	filename := fmt.Sprintf("recording_%s.mov", ts)
	_ = os.MkdirAll(r.cfg.OutputDir, 0755)
	outPath := filepath.Join(r.cfg.OutputDir, filename)

	var err error
	if len(r.segments) == 1 {
		// Prefer rename (atomic, instant); fall back to copy if cross-device.
		err = os.Rename(r.segments[0], outPath)
		if err != nil {
			err = copyFile(r.segments[0], outPath)
		}
	} else {
		err = SCKConcat(r.segments, outPath)
	}

	_ = os.RemoveAll(r.tempDir)
	r.state = Idle

	if err != nil {
		return "", err
	}
	return outPath, nil
}

func (r *Recorder) startSegment() error {
	segPath := filepath.Join(r.tempDir, fmt.Sprintf("seg_%03d.mov", len(r.segments)))

	captureAudio := ResolveAudioDevice(r.cfg.AudioDevice)
	log.Printf("SCK start: path=%s audio=%v", segPath, captureAudio)

	rid, err := SCKStart(segPath, captureAudio)
	if err != nil {
		return fmt.Errorf("recording failed: %w", err)
	}

	r.sckID = rid
	r.segments = append(r.segments, segPath)
	return nil
}

func (r *Recorder) stopSegment() error {
	if r.sckID == 0 {
		return nil
	}
	log.Printf("SCK stop: id=%d", r.sckID)
	err := SCKStop(r.sckID)
	r.sckID = 0
	return err
}

// copyFile copies src to dst, working across filesystems.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

