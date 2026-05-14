const idleEl = document.getElementById("idle");
const activeEl = document.getElementById("active");
const timerEl = document.getElementById("timer");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const opts = document.querySelectorAll(".opt");

let timerInterval = null;

// Load saved quality
chrome.storage.local.get("quality", ({ quality }) => {
  const q = quality || "mid";
  opts.forEach((o) => o.classList.toggle("selected", o.dataset.q === q));
});

// Quality selection
opts.forEach((btn) => {
  btn.addEventListener("click", () => {
    opts.forEach((o) => o.classList.remove("selected"));
    btn.classList.add("selected");
    chrome.storage.local.set({ quality: btn.dataset.q });
  });
});

// Check current state
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

// Start recording
btnStart.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.runtime.sendMessage({ action: "start", tabId: tab.id });
  setTimeout(() => {
    chrome.runtime.sendMessage({ action: "getState" }, (state) => {
      if (state && state.recording) showActive(state);
    });
  }, 600);
});

// Stop recording
btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stop" });
  showIdle();
});
