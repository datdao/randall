// Randall — service worker
// Click = start recording. Click again = stop and save.

const recordings = new Map(); // tabId → { tabTitle, startedAt }

// ─── Icon Click Toggle ───────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (recordings.has(tab.id)) {
      await stopRecording(tab.id);
    } else {
      await startRecording(tab);
    }
  } catch (err) {
    showError(tab.id, err.message || String(err));
  }
});

// ─── Recording ───────────────────────────────────────────────────────────────

async function startRecording(tab) {
  // Get stream ID for the active tab
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });

  recordings.set(tab.id, {
    tabTitle: tab.title || "Untitled",
    startedAt: Date.now(),
  });

  // Create offscreen document if needed
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Recording tab audio/video via MediaRecorder",
    });
    await new Promise((r) => setTimeout(r, 500));
  }

  chrome.runtime.sendMessage({
    target: "offscreen",
    action: "start",
    tabId: tab.id,
    streamId,
  });

  updateBadge();
  chrome.action.setTitle({ tabId: tab.id, title: "Click to stop recording" });
}

async function stopRecording(tabId) {
  chrome.runtime.sendMessage({
    target: "offscreen",
    action: "stop",
    tabId,
  });
}

// ─── Messages from offscreen ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "service-worker") return;

  if (msg.event === "stopped") {
    saveRecording(msg.tabId, msg.blob);
  } else if (msg.event === "error") {
    console.error("[randall]", msg.detail);
    showError(msg.tabId, msg.detail);
    recordings.delete(msg.tabId);
    updateBadge();
  }
});

function saveRecording(tabId, blobUrl) {
  const rec = recordings.get(tabId);
  if (!rec) return;

  const timestamp = new Date(rec.startedAt)
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const safeName = rec.tabTitle
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .slice(0, 50);
  const filename = `${safeName}_${timestamp}.webm`;

  if (blobUrl) {
    chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
  }

  recordings.delete(tabId);
  updateBadge();
  chrome.action.setTitle({ tabId, title: "Click to record this tab" });
}

// ─── Badge ───────────────────────────────────────────────────────────────────

function updateBadge() {
  const count = recordings.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function showError(tabId, message) {
  console.error("[randall] Error:", message);
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#F59E0B" });
  if (tabId) {
    chrome.action.setTitle({ tabId, title: "Error: " + message });
  }
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 5000);
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}
