# Randall – macOS Meeting Recorder

A native macOS menu bar application that auto-detects meeting browser tabs (Google Meet, Zoom, Teams, etc.) and lets you record your screen with one click.

## Features

- **Menu bar icon** – lives in your macOS status bar
- **Auto-detect meetings** – scans Chrome, Safari, Edge, Arc, Brave, Firefox for active meeting tabs
- **Per-meeting controls** – Start / Pause / Resume / Stop recording for each detected meeting
- **Configurable settings** – resolution (default 1080×720), FPS (default 30), output folder
- **Timestamp-prefixed files** – recordings saved as `recording_2025-01-15_14-30-00.mp4`
- **Rename on stop** – native dialog to rename the file when you stop recording
- **Pause & resume** – segments are automatically concatenated into a single file

## Prerequisites

- **macOS** 12.0+
- **Go** 1.21+
- **ffmpeg** – install via Homebrew:

```bash
brew install ffmpeg
```

## Build & Run

```bash
# Build the binary
make build

# Run directly
make run

# Install to /usr/local/bin
make install

# Build a macOS .app bundle (menu-bar only, no dock icon)
make app
```

## Configuration

Settings are stored in `~/.randall/config.json`:

```json
{
  "width": 1080,
  "height": 720,
  "fps": 30,
  "output_dir": "/Users/you/Movies/Randall"
}
```

You can also change settings directly from the menu bar:
- **Resolution** – click to enter custom WxH
- **FPS** – click to enter frame rate (1–120)
- **Folder** – click to pick output directory via native folder picker
- **Open Output Folder** – reveal recordings in Finder
- **Edit Config File** – open JSON config in your default editor

## How It Works

1. The app scans all supported browsers every 10 seconds using AppleScript
2. Tabs matching meeting URL patterns (meet.google.com, zoom.us, teams.microsoft.com, etc.) are listed in the menu
3. Click **Start Recording** to begin screen capture via ffmpeg (avfoundation)
4. Use **Pause** / **Resume** to pause recording (creates segments that get merged)
5. Click **Stop** to end recording — a dialog lets you rename the file
6. Recordings are saved to the configured output folder

## Supported Browsers

- Google Chrome / Canary
- Microsoft Edge
- Safari
- Arc
- Brave
- Vivaldi
- Firefox (window title matching only)

## Supported Meeting Platforms

- Google Meet
- Zoom (web client)
- Microsoft Teams
- Webex
- Whereby
- Gather Town
- Around
- Tuple
- Pop

## Permissions

The app requires:
- **Accessibility** permission (for AppleScript browser tab detection)
- **Screen Recording** permission (for ffmpeg screen capture)

Grant these in **System Settings → Privacy & Security**.

## License

MIT
