const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SW_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "extension", "service-worker.js"),
  "utf8"
);

function flushPromises() {
  return new Promise((resolve) => process.nextTick(resolve));
}

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await flushPromises();
}

// ─── Chrome API stub factory ──────────────────────────────────────────────────

function createChrome(storageInit = {}) {
  const storage = { ...storageInit };
  const listeners = {
    onMessage: [],
    onRemoved: [],
    onStartup: [],
    onInstalled: [],
  };

  const chrome = {
    storage: {
      local: {
        get: jest.fn((key) => {
          if (typeof key === "string") {
            return Promise.resolve({ [key]: storage[key] });
          }
          const out = {};
          for (const k of [].concat(key)) out[k] = storage[k];
          return Promise.resolve(out);
        }),
        set: jest.fn((items) => {
          Object.assign(storage, items);
          return Promise.resolve();
        }),
        remove: jest.fn((key) => {
          delete storage[key];
          return Promise.resolve();
        }),
      },
    },
    runtime: {
      onMessage: {
        addListener: jest.fn((fn) => listeners.onMessage.push(fn)),
      },
      onStartup: {
        addListener: jest.fn((fn) => listeners.onStartup.push(fn)),
      },
      onInstalled: {
        addListener: jest.fn((fn) => listeners.onInstalled.push(fn)),
      },
      sendMessage: jest.fn(),
      getContexts: jest.fn(() => Promise.resolve([])),
      lastError: null,
    },
    tabs: {
      onRemoved: {
        addListener: jest.fn((fn) => listeners.onRemoved.push(fn)),
      },
      get: jest.fn((id) =>
        Promise.resolve({ id, title: "Test Tab" })
      ),
    },
    tabCapture: {
      getMediaStreamId: jest.fn((opts, cb) => cb("stream-123")),
    },
    offscreen: {
      createDocument: jest.fn(() => Promise.resolve()),
    },
    action: {
      setBadgeText: jest.fn(),
      setBadgeBackgroundColor: jest.fn(),
    },
    downloads: {
      download: jest.fn(),
    },
  };

  return { chrome, storage, listeners };
}

// ─── Loader: runs service-worker.js in an isolated context ────────────────────

function loadSW(storageInit = {}) {
  const env = createChrome(storageInit);

  const sandbox = vm.createContext({
    chrome: env.chrome,
    console,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Date,
    Error,
    String,
    Object,
    Array,
    Math,
    JSON,
    RegExp,
    Number,
    parseInt,
    undefined,
  });

  vm.runInContext(SW_SOURCE, sandbox);

  const msgListener = env.listeners.onMessage[0];
  const tabRemovedListener = env.listeners.onRemoved[0];

  function sendMsg(msg) {
    const sendResponse = jest.fn();
    msgListener(msg, {}, sendResponse);
    return sendResponse;
  }

  return { ...env, sandbox, sendMsg, msgListener, tabRemovedListener };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("service-worker", () => {
  // ── State restoration ───────────────────────────────────────────────────────

  describe("state restoration", () => {
    test("restores recording from storage and sets badge", async () => {
      const { chrome } = loadSW({
        recording: { tabId: 42, tabTitle: "Saved", startedAt: 1000 },
      });
      await flush();

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({
        text: "REC",
      });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
        color: "#EF4444",
      });
    });

    test("starts with no recording when storage is empty", async () => {
      const { sendMsg } = loadSW();
      await flush();

      const resp = sendMsg({ action: "getState" });
      await flush();

      expect(resp).toHaveBeenCalledWith(null);
    });
  });

  // ── getState ────────────────────────────────────────────────────────────────

  describe("getState", () => {
    test("returns null when idle", async () => {
      const { sendMsg } = loadSW();
      await flush();

      const resp = sendMsg({ action: "getState" });
      await flush();

      expect(resp).toHaveBeenCalledWith(null);
    });

    test("returns recording info when active", async () => {
      const { sendMsg } = loadSW({
        recording: { tabId: 1, tabTitle: "T", startedAt: 5000 },
      });
      await flush();

      const resp = sendMsg({ action: "getState" });
      await flush();

      expect(resp).toHaveBeenCalledWith({
        recording: true,
        startedAt: 5000,
      });
    });
  });

  // ── handleStart ─────────────────────────────────────────────────────────────

  describe("handleStart", () => {
    test("captures tab and sends start to offscreen", async () => {
      const { sendMsg, chrome, storage } = loadSW();
      await flush();

      sendMsg({ action: "start", tabId: 7 });
      await flush(20);

      // State persisted
      expect(storage.recording).toBeDefined();
      expect(storage.recording.tabId).toBe(7);
      expect(storage.recording.tabTitle).toBe("Test Tab");

      // Offscreen created
      expect(chrome.offscreen.createDocument).toHaveBeenCalled();

      // Start sent with stream id and quality
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "offscreen",
          action: "start",
          tabId: 7,
          streamId: "stream-123",
          tabTitle: "Test Tab",
        })
      );

      // Badge shows REC
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({
        text: "REC",
      });
    });

    test("ignores start when already recording", async () => {
      const { sendMsg, chrome } = loadSW({
        recording: { tabId: 99, tabTitle: "Busy", startedAt: 1 },
      });
      await flush();

      sendMsg({ action: "start", tabId: 2 });
      await flush(20);

      expect(chrome.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    });

    test("uses selected quality preset", async () => {
      const { sendMsg, chrome } = loadSW({ quality: "high" });
      await flush();

      sendMsg({ action: "start", tabId: 1 });
      await flush(20);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          quality: {
            videoBitsPerSecond: 4_000_000,
            audioBitsPerSecond: 96_000,
            fps: 30,
          },
        })
      );
    });

    test("defaults to mid quality", async () => {
      const { sendMsg, chrome } = loadSW();
      await flush();

      sendMsg({ action: "start", tabId: 1 });
      await flush(20);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          quality: {
            videoBitsPerSecond: 1_500_000,
            audioBitsPerSecond: 96_000,
            fps: 15,
          },
        })
      );
    });
  });

  // ── stopRecording ───────────────────────────────────────────────────────────

  describe("stopRecording", () => {
    test("sends stop to offscreen with correct tabId", async () => {
      const { sendMsg, chrome } = loadSW({
        recording: { tabId: 5, tabTitle: "R", startedAt: 1 },
      });
      await flush();

      sendMsg({ action: "stop" });
      await flush();

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        target: "offscreen",
        action: "stop",
        tabId: 5,
      });
    });

    test("does nothing when not recording", async () => {
      const { sendMsg, chrome } = loadSW();
      await flush();

      sendMsg({ action: "stop" });
      await flush();

      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ── Tab close ───────────────────────────────────────────────────────────────

  describe("tab close", () => {
    test("auto-stops when recorded tab is closed", async () => {
      const { tabRemovedListener, chrome } = loadSW({
        recording: { tabId: 10, tabTitle: "Close Me", startedAt: 1 },
      });
      await flush();

      tabRemovedListener(10);
      await flush();

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        target: "offscreen",
        action: "stop",
        tabId: 10,
      });
    });

    test("ignores close of unrelated tabs", async () => {
      const { tabRemovedListener, chrome } = loadSW({
        recording: { tabId: 10, tabTitle: "X", startedAt: 1 },
      });
      await flush();

      tabRemovedListener(99);
      await flush();

      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ── Offscreen events ────────────────────────────────────────────────────────

  describe("offscreen events", () => {
    test("savedToFolder clears state without download", async () => {
      const { sendMsg, chrome, storage } = loadSW({
        recording: { tabId: 1, tabTitle: "T", startedAt: 1 },
      });
      await flush();

      sendMsg({
        target: "service-worker",
        event: "stopped",
        savedToFolder: true,
        blob: null,
      });
      await flush();

      // State cleared
      expect(storage.recording).toBeUndefined();
      expect(chrome.downloads.download).not.toHaveBeenCalled();
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    });

    test("stopped with blob triggers download", async () => {
      const startedAt = new Date("2026-05-14T13:00:00.000Z").getTime();
      const { sendMsg, chrome, storage } = loadSW({
        recording: {
          tabId: 1,
          tabTitle: "Google Meet",
          startedAt,
        },
      });
      await flush();

      sendMsg({
        target: "service-worker",
        event: "stopped",
        savedToFolder: false,
        blob: "blob:http://x/abc",
      });
      await flush();

      expect(chrome.downloads.download).toHaveBeenCalledWith({
        url: "blob:http://x/abc",
        filename: "Google Meet_2026-05-14T13-00-00.webm",
        saveAs: false,
      });
      expect(storage.recording).toBeUndefined();
    });

    test("error clears recording state", async () => {
      const { sendMsg, storage, chrome } = loadSW({
        recording: { tabId: 1, tabTitle: "T", startedAt: 1 },
      });
      await flush();

      sendMsg({
        target: "service-worker",
        event: "error",
        detail: "boom",
      });
      await flush();

      expect(storage.recording).toBeUndefined();
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    });

    test("recovered triggers download to downloads folder", async () => {
      const { sendMsg, chrome } = loadSW();
      await flush();

      sendMsg({
        target: "service-worker",
        event: "recovered",
        blob: "blob:http://x/rec",
      });
      await flush();

      expect(chrome.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "blob:http://x/rec",
          saveAs: false,
        })
      );
      const filename = chrome.downloads.download.mock.calls[0][0].filename;
      expect(filename).toMatch(/^Randall_recovered_\d+\.webm$/);
    });

    test("recovered without blob does not download", async () => {
      const { sendMsg, chrome } = loadSW();
      await flush();

      sendMsg({
        target: "service-worker",
        event: "recovered",
        blob: null,
      });
      await flush();

      expect(chrome.downloads.download).not.toHaveBeenCalled();
    });
  });

  // ── Badge ───────────────────────────────────────────────────────────────────

  describe("badge", () => {
    test("shows REC when recording starts", async () => {
      const { sendMsg, chrome } = loadSW();
      await flush();

      sendMsg({ action: "start", tabId: 1 });
      await flush(20);

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({
        text: "REC",
      });
    });

    test("clears badge when recording stops", async () => {
      const { sendMsg, chrome } = loadSW({
        recording: { tabId: 1, tabTitle: "T", startedAt: 1 },
      });
      await flush();
      chrome.action.setBadgeText.mockClear();

      sendMsg({
        target: "service-worker",
        event: "stopped",
        savedToFolder: true,
      });
      await flush();

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    });
  });

  // ── Quality presets ─────────────────────────────────────────────────────────

  describe("quality presets", () => {
    const expected = {
      low: { videoBitsPerSecond: 500_000, audioBitsPerSecond: 96_000, fps: 5 },
      mid: {
        videoBitsPerSecond: 1_500_000,
        audioBitsPerSecond: 96_000,
        fps: 15,
      },
      high: {
        videoBitsPerSecond: 4_000_000,
        audioBitsPerSecond: 96_000,
        fps: 30,
      },
    };

    test.each(Object.entries(expected))(
      "%s preset has correct values",
      async (level, preset) => {
        const { sendMsg, chrome } = loadSW({ quality: level });
        await flush();

        sendMsg({ action: "start", tabId: 1 });
        await flush(20);

        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ quality: preset })
        );
      }
    );

    test("audio bitrate is 96 kbps across all presets", async () => {
      for (const level of ["low", "mid", "high"]) {
        const { sendMsg, chrome } = loadSW({ quality: level });
        await flush();

        sendMsg({ action: "start", tabId: 1 });
        await flush(20);

        const startCall = chrome.runtime.sendMessage.mock.calls.find(
          (c) => c[0].action === "start"
        );
        expect(startCall[0].quality.audioBitsPerSecond).toBe(96_000);
      }
    });
  });

  // ── Filename generation ─────────────────────────────────────────────────────

  describe("filename generation", () => {
    test("strips special characters from tab title", async () => {
      const { sendMsg, chrome } = loadSW({
        recording: {
          tabId: 1,
          tabTitle: 'Tab <with> "special" chars: |pipe|',
          startedAt: new Date("2026-01-01T00:00:00Z").getTime(),
        },
      });
      await flush();

      sendMsg({
        target: "service-worker",
        event: "stopped",
        savedToFolder: false,
        blob: "blob:test",
      });
      await flush();

      const filename = chrome.downloads.download.mock.calls[0][0].filename;
      expect(filename).not.toMatch(/[<>":|]/);
      expect(filename).toMatch(/\.webm$/);
    });

    test("truncates long titles to 50 characters", async () => {
      const { sendMsg, chrome } = loadSW({
        recording: {
          tabId: 1,
          tabTitle: "A".repeat(100),
          startedAt: new Date("2026-01-01T00:00:00Z").getTime(),
        },
      });
      await flush();

      sendMsg({
        target: "service-worker",
        event: "stopped",
        savedToFolder: false,
        blob: "blob:test",
      });
      await flush();

      const filename = chrome.downloads.download.mock.calls[0][0].filename;
      const titlePart = filename.split("_2026")[0];
      expect(titlePart.length).toBeLessThanOrEqual(50);
    });

    test("formats timestamp as ISO with dashes", async () => {
      const { sendMsg, chrome } = loadSW({
        recording: {
          tabId: 1,
          tabTitle: "Test",
          startedAt: new Date("2026-03-15T09:30:45.123Z").getTime(),
        },
      });
      await flush();

      sendMsg({
        target: "service-worker",
        event: "stopped",
        savedToFolder: false,
        blob: "blob:test",
      });
      await flush();

      const filename = chrome.downloads.download.mock.calls[0][0].filename;
      expect(filename).toBe("Test_2026-03-15T09-30-45.webm");
    });
  });

  // ── State persistence ───────────────────────────────────────────────────────

  describe("state persistence", () => {
    test("persists recording state on start", async () => {
      const { sendMsg, storage } = loadSW();
      await flush();

      sendMsg({ action: "start", tabId: 3 });
      await flush(20);

      expect(storage.recording).toEqual(
        expect.objectContaining({
          tabId: 3,
          tabTitle: "Test Tab",
        })
      );
    });

    test("clears persisted state on stop", async () => {
      const { sendMsg, storage } = loadSW({
        recording: { tabId: 1, tabTitle: "T", startedAt: 1 },
      });
      await flush();

      sendMsg({
        target: "service-worker",
        event: "stopped",
        savedToFolder: true,
      });
      await flush();

      expect(storage.recording).toBeUndefined();
    });

    test("clears persisted state on error", async () => {
      const { sendMsg, storage } = loadSW({
        recording: { tabId: 1, tabTitle: "T", startedAt: 1 },
      });
      await flush();

      sendMsg({
        target: "service-worker",
        event: "error",
        detail: "fail",
      });
      await flush();

      expect(storage.recording).toBeUndefined();
    });
  });

  // ── Recovery ────────────────────────────────────────────────────────────────

  describe("recovery", () => {
    test("registers onStartup and onInstalled listeners", async () => {
      const { chrome } = loadSW();
      await flush();

      expect(chrome.runtime.onStartup.addListener).toHaveBeenCalledTimes(1);
      expect(chrome.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1);
    });
  });
});
