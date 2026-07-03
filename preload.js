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

// Email. The page never holds credentials or talks to the network directly —
// it asks the main process to send (or to open the OS mail client as a
// fallback). The SMTP password is stored/encrypted in main and is never
// returned to the page.
contextBridge.exposeInMainWorld("mailer", {
  // mailto: fallback (no account configured).
  compose: (subject, body) => ipcRenderer.invoke("mail:compose", subject, body),
  // SMTP config: getConfig never includes the password (only `hasPassword`).
  getConfig: () => ipcRenderer.invoke("smtp:getConfig"),
  saveConfig: (cfg) => ipcRenderer.invoke("smtp:saveConfig", cfg),
  testConnection: () => ipcRenderer.invoke("smtp:test"),
  // Send an HTML message with inline-image (cid) attachments.
  send: (payload) => ipcRenderer.invoke("mail:send", payload),
  // Receiving: fetch the latest INBOX messages over IMAP (read-only).
  fetchInbox: (opts) => ipcRenderer.invoke("imap:fetch", opts),
  // Native menu items route through these.
  onEmailNote: (cb) => ipcRenderer.on("menu:email-note", () => cb()),
  onEmailSettings: (cb) => ipcRenderer.on("menu:email-settings", () => cb()),
  onFetchMail: (cb) => ipcRenderer.on("menu:fetch-mail", () => cb()),
});
