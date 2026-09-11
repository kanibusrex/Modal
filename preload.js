// preload.js — runs in an isolated context before the page's scripts.
//
// The note editor checks, at startup:
//     window.storage && typeof window.storage.get === "function"
// and then uses:
//     await window.storage.get(key)  ->  { value } | null   (null/throw = missing)
//     await window.storage.set(key, value)
//
// We expose exactly that surface, forwarding to the main process (which owns
// the on-disk JSON file). contextBridge keeps this safe: the page never gets
// direct access to Node or ipcRenderer, only these three async functions.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("storage", {
  get: (key) => ipcRenderer.invoke("storage:get", key),
  set: (key, value) => ipcRenderer.invoke("storage:set", key, value),
  delete: (key) => ipcRenderer.invoke("storage:delete", key),
  // Not used by the app, but handy for debugging where data lives.
  _path: () => ipcRenderer.invoke("storage:path"),
});

// PDF export. The renderer builds the HTML; main renders it in a hidden window
// and writes the resulting PDF to wherever the user's save dialog points.
contextBridge.exposeInMainWorld("pdfExporter", {
  export: (payload) => ipcRenderer.invoke("export:pdf", payload),
  onExportPdf: (cb) => ipcRenderer.on("menu:export-pdf", () => cb()),
});

// The renderer debounces saves, so main holds the window close until the
// renderer flushes any pending save and acks — otherwise a close landing
// mid-debounce would drop the last edit silently.
contextBridge.exposeInMainWorld("appLifecycle", {
  onBeforeClose: (cb) => ipcRenderer.on("app:before-close", () => cb()),
  ack: () => ipcRenderer.send("app:close-ack"),
});

// The window is frameless on every platform (see main.js) — no native
// minimize/maximize/close anywhere, so the page draws its own and drives
// them through these instead.
contextBridge.exposeInMainWorld("windowControls", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizeChange: (cb) => ipcRenderer.on("window:maximize-changed", (_evt, isMax) => cb(isMax)),
});
