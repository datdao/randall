// Offscreen document: manages MediaRecorder for tab capture.
// Chunks are saved to IndexedDB every second (crash backup).
// If a save folder is chosen, chunks are also written to a real file on disk
// and flushed every 10 s so the file is always valid — even after a crash.

const recorders = new Map();
const finalizing = new Set();

// File System writing state
let fsWritable = null;
let fsFileHandle = null;
let fsFlushTimer = null;
let writeChain = Promise.resolve();

console.log("[randall offscreen] loaded");

// ─── Messages ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;

  if (msg.action === "start") {
    startRecording(msg.tabId, msg.streamId, msg.quality, msg.tabTitle);
  } else if (msg.action === "stop") {
    stopRecording(msg.tabId);
  } else if (msg.action === "recover") {
    recoverChunks();
  }
});

// ─── Recording ────────────────────────────────────────────────────────────────

async function startRecording(tabId, streamId, qualityMsg, tabTitle) {
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

  const fps = (qualityMsg && qualityMsg.fps) || 5;
  stream.getVideoTracks().forEach((track) => {
    try {
      track.applyConstraints({ frameRate: { max: fps } });
    } catch {}
  });

  await clearChunks(tabId);

  const videoBits = (qualityMsg && qualityMsg.videoBitsPerSecond) || 1_000_000;
  const audioBits = (qualityMsg && qualityMsg.audioBitsPerSecond) || 64_000;

  // Try to open a file in the user's chosen folder
  await initFileSystem(tabTitle || "Recording");

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: videoBits,
    audioBitsPerSecond: audioBits,
  });

  recorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      const buffer = await e.data.arrayBuffer();
      await saveChunk(tabId, buffer, mimeType);
      appendToFile(buffer);
    }
  };

  recorder.onstop = () => finalize(tabId);

  recorder.onerror = (e) => {
    notify("error", tabId, "MediaRecorder error: " + e.error?.message);
    teardownFile();
    cleanup(tabId);
  };

  // Play captured audio back to speakers so the user can still hear it.
  // tabCapture mutes the tab by default — this re-routes audio output.
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  recorders.set(tabId, { recorder, stream, audioCtx });
  recorder.start(1000);
  console.log("[randall offscreen] recording tab", tabId);
}

// ─── File System Access API — write to real file on disk ──────────────────────

async function initFileSystem(tabTitle) {
  try {
    const handle = await loadFolderHandle();
    if (!handle) return;

    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") return;

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const safeName =
      tabTitle.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 50) ||
      "Recording";
    const filename = `${safeName}_${timestamp}.webm`;

    fsFileHandle = await handle.getFileHandle(filename, { create: true });
    fsWritable = await fsFileHandle.createWritable();
    writeChain = Promise.resolve();

    // Flush every 10 s — closes & reopens the stream so the on-disk file
    // is always a complete, playable WebM up to that point.
    fsFlushTimer = setInterval(() => flushFile(), 10_000);
    console.log("[randall offscreen] writing to:", filename);
  } catch (e) {
    console.error("[randall offscreen] initFileSystem failed:", e);
    fsWritable = null;
    fsFileHandle = null;
  }
}

function appendToFile(buffer) {
  if (!fsWritable) return;
  writeChain = writeChain.then(async () => {
    if (!fsWritable) return;
    try {
      await fsWritable.write(new Uint8Array(buffer));
    } catch (e) {
      console.error("[randall offscreen] append error:", e);
    }
  });
}

function flushFile() {
  if (!fsWritable || !fsFileHandle) return;
  writeChain = writeChain.then(async () => {
    if (!fsWritable || !fsFileHandle) return;
    try {
      await fsWritable.close();
      fsWritable = await fsFileHandle.createWritable({
        keepExistingData: true,
      });
      const file = await fsFileHandle.getFile();
      await fsWritable.seek(file.size);
    } catch (e) {
      console.error("[randall offscreen] flush error:", e);
      fsWritable = null;
    }
  });
}

function closeFile() {
  clearInterval(fsFlushTimer);
  fsFlushTimer = null;
  if (!fsWritable) return Promise.resolve(false);

  return new Promise((resolve) => {
    writeChain = writeChain.then(async () => {
      try {
        await fsWritable.close();
        fsWritable = null;
        fsFileHandle = null;
        resolve(true);
      } catch (e) {
        console.error("[randall offscreen] closeFile error:", e);
        fsWritable = null;
        fsFileHandle = null;
        resolve(false);
      }
    });
  });
}

function teardownFile() {
  clearInterval(fsFlushTimer);
  fsFlushTimer = null;
  try {
    if (fsWritable) fsWritable.close().catch(() => {});
  } catch {}
  fsWritable = null;
  fsFileHandle = null;
}

// ─── Stop / Finalize ──────────────────────────────────────────────────────────

function stopRecording(tabId) {
  const entry = recorders.get(tabId);
  if (entry && entry.recorder.state !== "inactive") {
    entry.recorder.stop();
  } else {
    finalize(tabId);
  }
}

async function finalize(tabId) {
  if (finalizing.has(tabId)) return;
  finalizing.add(tabId);

  const savedToFolder = await closeFile();

  if (savedToFolder) {
    notify("stopped", tabId, null, true);
    await clearChunks(tabId);
  } else {
    const { chunks, mimeType: mt } = await loadChunks(tabId);
    if (chunks.length > 0) {
      const blob = new Blob(chunks.map((c) => new Blob([c])), { type: mt });
      const blobUrl = URL.createObjectURL(blob);
      notify("stopped", tabId, blobUrl, false);
    } else {
      notify("stopped", tabId, null, false);
    }
    await clearChunks(tabId);
  }

  cleanup(tabId);
  finalizing.delete(tabId);
}

function cleanup(tabId) {
  const entry = recorders.get(tabId);
  if (!entry) return;
  entry.stream.getTracks().forEach((t) => t.stop());
  if (entry.audioCtx) entry.audioCtx.close().catch(() => {});
  recorders.delete(tabId);
}

function notify(event, tabId, detail, savedToFolder) {
  chrome.runtime.sendMessage({
    target: "service-worker",
    event,
    tabId,
    ...(event === "stopped"
      ? { blob: detail, savedToFolder: !!savedToFolder }
      : { detail }),
  });
}

// ─── Crash Recovery ───────────────────────────────────────────────────────────

async function recoverChunks() {
  const db = await openDB();
  const tx = db.transaction("chunks", "readonly");
  const store = tx.objectStore("chunks");
  const countReq = store.count();
  await new Promise((r) => (countReq.onsuccess = r));
  db.close();

  if (countReq.result === 0) return;

  const { chunks, mimeType } = await loadAllChunks();
  if (chunks.length === 0) return;

  const blob = new Blob(chunks.map((c) => new Blob([c])), { type: mimeType });

  // Try writing to the chosen folder first
  let saved = false;
  try {
    const handle = await loadFolderHandle();
    if (handle) {
      const perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") {
        const filename = `Randall_recovered_${Date.now()}.webm`;
        const fh = await handle.getFileHandle(filename, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        saved = true;
      }
    }
  } catch (e) {
    console.error("[randall offscreen] recovery folder write failed:", e);
  }

  if (!saved) {
    const blobUrl = URL.createObjectURL(blob);
    notify("recovered", 0, blobUrl);
  }

  await clearAllChunks();
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

// ─── IndexedDB — chunk persistence ───────────────────────────────────────────

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

// ─── IndexedDB — settings (shared with popup for folder handle) ───────────────

function openSettingsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("randall_settings", 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadFolderHandle() {
  try {
    const db = await openSettingsDB();
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get("folderHandle");
    await new Promise((r) => (req.onsuccess = r));
    db.close();
    return req.result || null;
  } catch {
    return null;
  }
}
