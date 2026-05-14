// Offscreen document: manages MediaRecorder instances for tab capture.

const recorders = new Map(); // tabId → { recorder, chunks, stream }

console.log("[randall offscreen] loaded");

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  console.log("[randall offscreen] received:", msg.action, msg.tabId);

  if (msg.action === "start") {
    startRecording(msg.tabId, msg.streamId);
  } else if (msg.action === "stop") {
    stopRecording(msg.tabId);
  }
});

async function startRecording(tabId, streamId) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });
    console.log("[randall offscreen] got stream for tab", tabId);
  } catch (err) {
    console.error("[randall offscreen] getUserMedia failed:", err);
    notify("error", tabId, "Failed to capture tab: " + err.message);
    return;
  }

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";

  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 3_000_000,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  recorder.onstop = () => {
    console.log("[randall offscreen] recorder stopped, chunks:", chunks.length);
    const blob = new Blob(chunks, { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    notify("stopped", tabId, blobUrl);
    cleanup(tabId);
  };

  recorder.onerror = (e) => {
    console.error("[randall offscreen] recorder error:", e.error);
    notify("error", tabId, "MediaRecorder error: " + e.error?.message);
    cleanup(tabId);
  };

  recorders.set(tabId, { recorder, chunks, stream });
  recorder.start(1000);
  console.log("[randall offscreen] recording started for tab", tabId);
}

function stopRecording(tabId) {
  const entry = recorders.get(tabId);
  if (entry && entry.recorder.state !== "inactive") {
    entry.recorder.stop();
  } else {
    notify("stopped", tabId, null);
    cleanup(tabId);
  }
}

function cleanup(tabId) {
  const entry = recorders.get(tabId);
  if (!entry) return;
  entry.stream.getTracks().forEach((t) => t.stop());
  recorders.delete(tabId);
}

function notify(event, tabId, detail) {
  chrome.runtime.sendMessage({
    target: "service-worker",
    event,
    tabId,
    ...(event === "stopped" ? { blob: detail } : { detail }),
  });
}
