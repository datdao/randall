package recorder

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework CoreGraphics -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreAudio -framework CoreVideo -framework IOSurface -framework Foundation

#include <CoreGraphics/CoreGraphics.h>

static bool hasScreenCapture() {
	return CGPreflightScreenCaptureAccess();
}

static void requestScreenCapture() {
	CGRequestScreenCaptureAccess();
}

// Defined in sck_darwin.m
extern int sckStart(const char *path, int captureAudio, char *errBuf, int errBufLen);
extern int sckStop(int recorderID, char *errBuf, int errBufLen);
extern int sckConcat(const char **paths, int pathCount, const char *outputPath, char *errBuf, int errBufLen);
extern int listAudioInputDevices(char names[][256], int maxDevices);
*/
import "C"
import (
	"fmt"
	"unsafe"
)

// HasScreenCapturePermission returns true if the app has screen recording permission.
func HasScreenCapturePermission() bool {
	return bool(C.hasScreenCapture())
}

// RequestScreenCapturePermission triggers the macOS permission prompt and
// registers the app in System Settings → Privacy → Screen Recording.
func RequestScreenCapturePermission() {
	C.requestScreenCapture()
}

// SCKStart begins a ScreenCaptureKit recording to the given path.
// Returns a recorder ID (>0) on success, or an error.
func SCKStart(path string, captureAudio bool) (int, error) {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))

	var errBuf [512]C.char
	audioFlag := C.int(0)
	if captureAudio {
		audioFlag = 1
	}

	rid := int(C.sckStart(cpath, audioFlag, &errBuf[0], 512))
	if rid < 0 {
		return 0, fmt.Errorf("%s", C.GoString(&errBuf[0]))
	}
	return rid, nil
}

// SCKStop stops a ScreenCaptureKit recording by its ID.
// Returns an error if the writer failed to finalise the file.
func SCKStop(recorderID int) error {
	var errBuf [512]C.char
	if C.sckStop(C.int(recorderID), &errBuf[0], 512) < 0 {
		return fmt.Errorf("%s", C.GoString(&errBuf[0]))
	}
	return nil
}

// SCKConcat merges multiple .mov segment files into a single output file using
// AVMutableComposition (passthrough — no re-encode).
func SCKConcat(segments []string, outPath string) error {
	cPaths := make([]*C.char, len(segments))
	for i, s := range segments {
		cPaths[i] = C.CString(s)
		defer C.free(unsafe.Pointer(cPaths[i]))
	}

	cOut := C.CString(outPath)
	defer C.free(unsafe.Pointer(cOut))

	var errBuf [512]C.char
	ret := C.sckConcat((**C.char)(unsafe.Pointer(&cPaths[0])), C.int(len(segments)),
		cOut, &errBuf[0], 512)
	if ret < 0 {
		return fmt.Errorf("%s", C.GoString(&errBuf[0]))
	}
	return nil
}

// AudioDeviceInfo holds info about a CoreAudio input device.
type AudioDeviceInfo struct {
	Index string
	Name  string
}

// ListAudioDevices returns all available audio input devices via CoreAudio.
func ListAudioDevices() []AudioDeviceInfo {
	const maxDev = 32
	var names [maxDev][256]C.char
	count := int(C.listAudioInputDevices(&names[0], maxDev))

	var devices []AudioDeviceInfo
	for i := 0; i < count; i++ {
		name := C.GoString(&names[i][0])
		devices = append(devices, AudioDeviceInfo{
			Index: fmt.Sprintf("%d", i),
			Name:  name,
		})
	}
	return devices
}

// ResolveAudioDevice returns whether audio should be captured based on config.
func ResolveAudioDevice(audioDevice string) bool {
	if audioDevice == "" {
		return false
	}
	devices := ListAudioDevices()
	if len(devices) == 0 {
		return false
	}
	// "auto" or any valid device name → capture audio
	if audioDevice == "auto" {
		return true
	}
	for _, d := range devices {
		if d.Name == audioDevice {
			return true
		}
	}
	return false
}
