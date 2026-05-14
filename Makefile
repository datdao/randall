.PHONY: build run clean install app install-app uninstall uninstall-all reinstall reinstall-app icon

APP_NAME := randall
BUILD_DIR := build
APP_BUNDLE := $(BUILD_DIR)/Randall.app

build:
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=1 go build -o $(BUILD_DIR)/$(APP_NAME) .

run: build
	./$(BUILD_DIR)/$(APP_NAME)

install-cli: build
	cp $(BUILD_DIR)/$(APP_NAME) /usr/local/bin/$(APP_NAME)

# Generate app icon (.icns)
icon:
	@mkdir -p $(BUILD_DIR)
	@go run ./cmd/genicon $(BUILD_DIR)
	@iconutil -c icns -o $(BUILD_DIR)/Randall.icns $(BUILD_DIR)/Randall.iconset
	@echo "✅ Generated Randall.icns"

# Build macOS .app bundle
app: build icon
	@mkdir -p $(APP_BUNDLE)/Contents/MacOS
	@mkdir -p $(APP_BUNDLE)/Contents/Resources
	@cp $(BUILD_DIR)/$(APP_NAME) $(APP_BUNDLE)/Contents/MacOS/$(APP_NAME)
	@cp $(BUILD_DIR)/Randall.icns $(APP_BUNDLE)/Contents/Resources/AppIcon.icns
	@/usr/libexec/PlistBuddy -c "Clear dict" $(APP_BUNDLE)/Contents/Info.plist 2>/dev/null || true
	@/usr/libexec/PlistBuddy \
		-c "Add :CFBundleName string Randall" \
		-c "Add :CFBundleDisplayName string Randall" \
		-c "Add :CFBundleIdentifier string com.randall.recorder" \
		-c "Add :CFBundleVersion string 1.0.0" \
		-c "Add :CFBundleShortVersionString string 1.0.0" \
		-c "Add :CFBundleExecutable string $(APP_NAME)" \
		-c "Add :CFBundlePackageType string APPL" \
		-c "Add :LSUIElement bool true" \
		-c "Add :CFBundleIconFile string AppIcon" \
		-c "Add :NSMicrophoneUsageDescription string Randall needs microphone access to record meeting audio." \
		-c "Add :NSScreenCaptureUsageDescription string Randall needs screen recording access to capture meetings." \
		$(APP_BUNDLE)/Contents/Info.plist
	@echo -n "APPL????" > $(APP_BUNDLE)/Contents/PkgInfo
	@echo "✅ Built $(APP_BUNDLE)"

# Install .app to /Applications (shows in Launchpad & Spotlight)
# Resets TCC permissions so macOS re-prompts for Screen Recording, Microphone, etc.
install: build app
	@killall Randall 2>/dev/null || true
	@killall randall 2>/dev/null || true
	@tccutil reset ScreenCapture com.randall.recorder 2>/dev/null || true
	@tccutil reset Microphone com.randall.recorder 2>/dev/null || true
	@tccutil reset Accessibility com.randall.recorder 2>/dev/null || true
	@tccutil reset AppleEvents com.randall.recorder 2>/dev/null || true
	@rm -rf /Applications/Randall.app
	@cp -R $(APP_BUNDLE) /Applications/Randall.app
	@/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f /Applications/Randall.app
	@killall Dock 2>/dev/null || true
	@echo "✅ Installed to /Applications/Randall.app (permissions reset — macOS will re-prompt on first use)"

uninstall-cli:
	@killall randall 2>/dev/null || true
	@rm -rf /Applications/Randall.app
	@rm -f /usr/local/bin/$(APP_NAME)
	@/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -u /Applications/Randall.app 2>/dev/null || true
	@killall Dock 2>/dev/null || true
	@echo "✅ Removed Randall.app and /usr/local/bin/$(APP_NAME). Run make uninstall-all to also remove ~/.randall."

# Removes app, CLI, Launch Services registration, and ~/.randall so the next launch is a clean default config.
uninstall: uninstall-cli
	@rm -rf "$(HOME)/.randall"
	@echo "✅ Removed ~/.randall — next launch recreates defaults (first-run config flow)."

clean:
	rm -rf $(BUILD_DIR)
