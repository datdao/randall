// Offscreen document: manages MediaRecorder instances for tab capture.
// Chunks are persisted to IndexedDB every second to survive crashes.

const recorders = new Map(); // tabId → { recorder, stream }

console.log("[randall offscreen] loaded");

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;

  if (msg.action === "start") {
    startRecording(msg.tabId, msg.streamId);
  } else if (msg.action === "stop") {
    stopRecording(msg.tabId);
  } else if (msg.action === "recover") {
    recoverChunks();
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
  } catch (err) {
    notify("error", tabId, "Failed to capture tab: " + err.message);
    return;
  }

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";

  // Clear any previous chunks for this tab
  await clearChunks(tabId);

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 3_000_000,
  });

  recorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      // Persist each chunk to IndexedDB immediately
      const buffer = await e.data.arrayBuffer();
      await saveChunk(tabId, buffer, mimeType);
    }
  };

  recorder.onstop = async () => {
    // Assemble final file from all persisted chunks
    const { chunks, mimeType: mt } = await loadChunks(tabId);
    if (chunks.length > 0) {
      const blob = new Blob(chunks.map((c) => new Blob([c])), { type: mt });
      const blobUrl = URL.createObjectURL(blob);
      notify("stopped", tabId, blobUrl);
    } else {
      notify("stopped", tabId, null);
    }
    await clearChunks(tabId);
    cleanup(tabId);
  };

  recorder.onerror = (e) => {
    notify("error", tabId, "MediaRecorder error: " + e.error?.message);
    cleanup(tabId);
  };

  recorders.set(tabId, { recorder, stream });
  recorder.start(1000); // 1-second chunks
  console.log("[randall offscreen] recording tab", tabId);
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

// ─── Crash Recovery ──────────────────────────────────────────────────────────

async function recoverChunks() {
  const db = await openDB();
  const tx = db.transaction("chunks", "readonly");
  const store = tx.objectStore("chunks");

  // Check if there are any chunks
  const countReq = store.count();
  await new Promise((r) => (countReq.onsuccess = r));
  db.close();

  if (countReq.result > 0) {
    // There are leftover chunks from a crash — recover them
    const { chunks, mimeType } = await loadAllChunks();
    if (chunks.length > 0) {
      const blob = new Blob(chunks.map((c) => new Blob([c])), { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      notify("recovered", 0, blobUrl);
      await clearAllChunks();
    }
  }
}

async function loadAllChunks() {
  const db = await openDB();
  const tx = db.transaction(["chunks", "meta"], "readonly");
  const chunks = [];
  const store = tx.objectStore("chunks");

  await new Promise((resolve) => {
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        chunks.push(cursor.value.buffer);
        cursor.continue();
      } else {
        resolve();
      }
    };
  });

  let mimeType = "video/webm";
  const metaStore = tx.objectStore("meta");
  const metaReq = metaStore.getAll();
  await new Promise((r) => (metaReq.onsuccess = r));
  if (metaReq.result && metaReq.result.length > 0) {
    mimeType = metaReq.result[0];
  }

  db.close();
  return { chunks, mimeType };
}

async function clearAllChunks() {
  const db = await openDB();
  const tx = db.transaction(["chunks", "meta"], "readwrite");
  tx.objectStore("chunks").clear();
  tx.objectStore("meta").clear();
  await new Promise((r) => (tx.oncomplete = r));
  db.close();
}

// ─── IndexedDB persistence ───────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("randall_recordings", 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("chunks")) {
        db.createObjectStore("chunks", { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveChunk(tabId, buffer, mimeType) {
  const db = await openDB();
  const tx = db.transaction(["chunks", "meta"], "readwrite");
  tx.objectStore("chunks").add({ tabId, buffer, ts: Date.now() });
  tx.objectStore("meta").put(mimeType, `mime_${tabId}`);
  await new Promise((r) => (tx.oncomplete = r));
  db.close();
}

async function loadChunks(tabId) {
  const db = await openDB();
  const tx = db.transaction(["chunks", "meta"], "readonly");

  const chunks = [];
  const store = tx.objectStore("chunks");
  await new Promise((resolve) => {
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.tabId === tabId) {
          chunks.push(cursor.value.buffer);
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
  });

  let mimeType = "video/webm";
  const metaReq = tx.objectStore("meta").get(`mime_${tabId}`);
  await new Promise((r) => (metaReq.onsuccess = r));
  if (metaReq.result) mimeType = metaReq.result;

  db.close();
  return { chunks, mimeType };
}

async function clearChunks(tabId) {
  const db = await openDB();
  const tx = db.transaction(["chunks", "meta"], "readwrite");
  const store = tx.objectStore("chunks");

  await new Promise((resolve) => {
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.tabId === tabId) {
          cursor.delete();
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
  });

  tx.objectStore("meta").delete(`mime_${tabId}`);
  await new Promise((r) => (tx.oncomplete = r));
  db.close();
}
