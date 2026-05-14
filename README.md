# Randall

A Chrome extension that records any browser tab. Click to start, click to stop.

## Features

- **One-click recording** — click the icon to start, click again to stop
- **True tab capture** — records only that tab's content (video + audio)
- **Background recording** — switch tabs freely, recording continues
- **Multi-tab** — record multiple tabs simultaneously
- **Save as WebM** — downloads with timestamped filename

## Install

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the extension from the 🧩 puzzle menu

## Usage

1. Go to any tab
2. **Click the Randall icon** → recording starts (badge shows count)
3. Work freely — switch tabs, the recording continues
4. **Click the icon again** on that tab → stops and saves `.webm`

## Dev

```bash
make dev     # launch isolated Chrome with extension loaded
make clean   # remove temp Chrome profile
```

## Structure

```
extension/
├── manifest.json       Manifest V3 config
├── service-worker.js   Click handler, state, tab capture
├── offscreen.html/js   MediaRecorder (background)
└── icons/              Extension icons
```
