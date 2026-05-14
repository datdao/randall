const idleEl = document.getElementById("idle");
const activeEl = document.getElementById("active");
const timerEl = document.getElementById("timer");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnFolder = document.getElementById("btn-folder");
const opts = document.querySelectorAll(".opt");

let timerInterval = null;

// ─── Quality ──────────────────────────────────────────────────────────────────

chrome.storage.local.get("quality", ({ quality }) => {
  const q = quality || "mid";
  opts.forEach((o) => o.classList.toggle("selected", o.dataset.q === q));
});

opts.forEach((btn) => {
  btn.addEventListener("click", () => {
    opts.forEach((o) => o.classList.remove("selected"));
    btn.classList.add("selected");
    chrome.storage.local.set({ quality: btn.dataset.q });
  });
});

// ─── Folder picker ────────────────────────────────────────────────────────────

function refreshFolderLabel() {
  chrome.storage.local.get("folderName", ({ folderName }) => {
    if (folderName) {
      btnFolder.textContent = folderName;
      btnFolder.classList.add("chosen");
    }
  });
}
refreshFolderLabel();

btnFolder.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("choose-folder.html") });
});

// ─── State ────────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ action: "getState" }, (state) => {
  if (state && state.recording) {
    showActive(state);
  } else {
    showIdle();
  }
});

function showIdle() {
  idleEl.classList.remove("hidden");
  activeEl.classList.add("hidden");
  clearInterval(timerInterval);
}

function showActive(state) {
  idleEl.classList.add("hidden");
  activeEl.classList.remove("hidden");
  startTimer(state.startedAt);
}

function startTimer(startedAt) {
  clearInterval(timerInterval);
  const update = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    timerEl.textContent =
      String(Math.floor(s / 60)).padStart(2, "0") + ":" +
      String(s % 60).padStart(2, "0");
  };
  update();
  timerInterval = setInterval(update, 1000);
}

// ─── Start ────────────────────────────────────────────────────────────────────

btnStart.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Ensure folder permission is granted (needs user gesture from this click)
  const handle = await loadFolderHandle();
  if (handle) {
    try {
      await handle.requestPermission({ mode: "readwrite" });
    } catch {}
  }

  chrome.runtime.sendMessage({ action: "start", tabId: tab.id });
  setTimeout(() => {
    chrome.runtime.sendMessage({ action: "getState" }, (state) => {
      if (state && state.recording) showActive(state);
    });
  }, 600);
});

// ─── Stop ─────────────────────────────────────────────────────────────────────

btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stop" });
  showIdle();
});

// ─── IndexedDB helpers for folder handle (shared DB with offscreen) ───────────

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
