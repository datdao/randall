// Randall — service worker
// Popup controls recording. One tab at a time.
// Recording state is persisted to chrome.storage.local so it survives
// service worker suspension (MV3 can kill the worker after ~30 s idle).

let recording = null; // { tabId, tabTitle, startedAt }

// Restore in-memory state from storage when the worker wakes up
const stateReady = chrome.storage.local.get("recording").then(({ recording: saved }) => {
  if (saved) {
    recording = saved;
    updateBadge();
  }
});

const QUALITY = {
  low:  { videoBitsPerSecond: 500_000,   audioBitsPerSecond: 96_000,  fps: 5 },
  mid:  { videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000,  fps: 15 },
  high: { videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 96_000,  fps: 30 },
};

function persistRecording() {
  if (recording) {
    chrome.storage.local.set({ recording });
  } else {
    chrome.storage.local.remove("recording");
  }
}

// ─── Auto-stop when recorded tab is closed ───────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await stateReady;
  if (recording && recording.tabId === tabId) {
    stopRecording();
  }
});

// ─── Recover unsaved recordings on startup ───────────────────────────────────

chrome.runtime.onStartup.addListener(checkRecovery);
chrome.runtime.onInstalled.addListener(checkRecovery);

async function checkRecovery() {
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Recovering unsaved recording data",
    });
    await new Promise((r) => setTimeout(r, 300));
  }
  chrome.runtime.sendMessage({ target: "offscreen", action: "recover" });
}

// ─── Messages ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getState") {
    stateReady.then(() => {
      sendResponse(recording ? { recording: true, startedAt: recording.startedAt } : null);
    });
    return true;
  }
  if (msg.action === "start") {
    handleStart(msg.tabId);
    return;
  }
  if (msg.action === "stop") {
    stopRecording();
    return;
  }

  // From offscreen
  if (msg.target === "service-worker") {
    if (msg.event === "recovered") {
      const filename = `Randall_recovered_${Date.now()}.webm`;
      if (msg.blob) {
        chrome.downloads.download({ url: msg.blob, filename, saveAs: false });
      }
    } else if (msg.event === "stopped") {
      if (msg.savedToFolder) {
        recording = null;
        persistRecording();
        updateBadge();
      } else {
        saveRecording(msg.blob);
      }
    } else if (msg.event === "error") {
      console.error("[randall]", msg.detail);
      recording = null;
      persistRecording();
      updateBadge();
    }
  }
});

// ─── Recording ───────────────────────────────────────────────────────────────

async function handleStart(tabId) {
  await stateReady;
  if (recording) return; // already recording

  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });

    const { quality } = await chrome.storage.local.get("quality");
    const q = QUALITY[quality] || QUALITY.mid;

    const tab = await chrome.tabs.get(tabId);
    recording = {
      tabId,
      tabTitle: tab.title || "Untitled",
      startedAt: Date.now(),
    };
    persistRecording();

    if (!(await hasOffscreen())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Recording tab audio/video via MediaRecorder",
      });
      await new Promise((r) => setTimeout(r, 300));
    }

    chrome.runtime.sendMessage({
      target: "offscreen",
      action: "start",
      tabId,
      streamId,
      quality: q,
      tabTitle: recording.tabTitle,
    });

    updateBadge();
  } catch (err) {
    console.error("[randall] start failed:", err);
  }
}

function stopRecording() {
  if (!recording) return;
  chrome.runtime.sendMessage({ target: "offscreen", action: "stop", tabId: recording.tabId });
}

// ─── Save ────────────────────────────────────────────────────────────────────

function saveRecording(blobUrl) {
  if (!recording) return;

  const timestamp = new Date(recording.startedAt)
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const safeName = recording.tabTitle
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .slice(0, 50);
  const filename = `${safeName}_${timestamp}.webm`;

  if (blobUrl) {
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
  }

  recording = null;
  persistRecording();
  updateBadge();
}

// ─── Badge ───────────────────────────────────────────────────────────────────

function updateBadge() {
  if (recording) {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}
