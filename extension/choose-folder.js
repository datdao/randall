const currentEl = document.getElementById("current");
const btnPick = document.getElementById("btn-pick");
const doneEl = document.getElementById("done");

// Show current folder
chrome.storage.local.get("folderName", ({ folderName }) => {
  if (folderName) {
    currentEl.textContent = "Current: " + folderName;
  }
});

btnPick.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({
      startIn: "downloads",
      mode: "readwrite",
    });

    await storeFolderHandle(handle);
    chrome.storage.local.set({ folderName: handle.name });

    currentEl.textContent = "Current: " + handle.name;
    doneEl.textContent = "Saved! You can close this tab.";
    doneEl.style.display = "block";
  } catch {
    // user cancelled
  }
});

// ─── IndexedDB helpers (same as popup.js / offscreen.js) ──────────────────────

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

async function storeFolderHandle(handle) {
  const db = await openSettingsDB();
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(handle, "folderHandle");
  await new Promise((r) => (tx.oncomplete = r));
  db.close();
}
