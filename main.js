// main.js — Electron main process for "modal"
//
// Responsibilities:
//   1. Create the application window and load the note editor (index.html).
//   2. Back the renderer's `window.storage` API with a real file on disk
//      (in the OS per-user app-data directory) via IPC. This replaces the
//      artifact host's storage so notes — including pasted images stored as
//      base64 — persist across launches without the ~5MB localStorage limit.
//   3. Provide a native menu and send external links to the system browser.

const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

// --- Single instance: focus the existing window instead of opening a second one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// File-backed key/value store
// ---------------------------------------------------------------------------
// The renderer expects an async store with:
//   get(key)        -> { value: <string> }  when present, or null when missing
//   set(key, value) -> truthy on success
// We persist the whole store as one JSON file. Writes are debounced and atomic
// (write to a temp file, then rename) so a crash mid-write can't corrupt data.

let storeFilePath = null;     // resolved in app.whenReady once userData exists
let backupsDir = null;
let storeCache = null;        // in-memory mirror: { [key]: string }
let writeTimer = null;
let writePromise = Promise.resolve();
let lastBackupDay = null;     // "YYYY-MM-DD" of the last daily backup taken

function loadStoreFromDisk() {
  try {
    const raw = fs.readFileSync(storeFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {}; // missing or unreadable -> start empty
  }
}

// Once per calendar day, before the first write of that day lands, copy
// whatever is currently on disk into backups/. This is the safety net for
// "today's session wrote something bad" — the prior day's known-good file
// is still there. Keeps at most MAX_BACKUPS files.
const MAX_BACKUPS = 14;
async function maybeBackupBeforeWrite() {
  if (!storeFilePath || !fs.existsSync(storeFilePath)) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastBackupDay === today) return;
  lastBackupDay = today;
  try {
    await fsp.mkdir(backupsDir, { recursive: true });
    await fsp.copyFile(storeFilePath, path.join(backupsDir, `modal-store-${today}.json`));
    const files = (await fsp.readdir(backupsDir)).filter((f) => f.startsWith("modal-store-")).sort();
    for (let i = 0; i < files.length - MAX_BACKUPS; i++) await fsp.unlink(path.join(backupsDir, files[i]));
  } catch (e) {
    console.error("modal: backup failed:", e);
  }
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushStore, 180);
}

function flushStore() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const snapshot = JSON.stringify(storeCache);
  const tmp = storeFilePath + ".tmp";
  // Chain writes so two flushes never interleave on the same file.
  writePromise = writePromise.then(async () => {
    try {
      await maybeBackupBeforeWrite();
      await fsp.writeFile(tmp, snapshot, "utf8");
      await fsp.rename(tmp, storeFilePath);
    } catch (e) {
      console.error("modal: failed to persist store:", e);
    }
  });
  return writePromise;
}

function initStore() {
  storeFilePath = path.join(app.getPath("userData"), "modal-store.json");
  backupsDir = path.join(app.getPath("userData"), "backups");
  storeCache = loadStoreFromDisk();
}

ipcMain.handle("storage:get", (_evt, key) => {
  if (!storeCache) return null;
  const value = storeCache[key];
  return value === undefined ? null : { value };
});

ipcMain.handle("storage:set", (_evt, key, value) => {
  if (!storeCache) storeCache = {};
  storeCache[key] = String(value);
  scheduleWrite();
  return true;
});

ipcMain.handle("storage:delete", (_evt, key) => {
  if (storeCache && key in storeCache) {
    delete storeCache[key];
    scheduleWrite();
  }
  return true;
});

// Let the renderer reveal where its data lives (used by the Help menu).
ipcMain.handle("storage:path", () => storeFilePath);

// --- PDF export ---
// Renders a caller-supplied HTML string in a hidden window, prints it to PDF,
// and writes the result to the path the user chose in a save dialog.
ipcMain.handle("export:pdf", async (_evt, payload) => {
  payload = payload || {};
  const html = String(payload.html || "");
  const suggested = String(payload.filename || "note.pdf");

  if (!mainWindow) return { ok: false, error: "No window available" };

  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath("documents"), suggested),
    filters: [{ name: "PDF Document", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const tmpHtml = path.join(app.getPath("temp"), "modal-print-" + Date.now() + ".html");
  try {
    await fsp.writeFile(tmpHtml, html, "utf8");
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true },
    });
    await printWin.loadFile(tmpHtml);
    const pdfData = await printWin.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
    });
    printWin.destroy();
    try { await fsp.unlink(tmpHtml); } catch (_) {}
    await fsp.writeFile(filePath, pdfData);
    return { ok: true };
  } catch (e) {
    try { await fsp.unlink(tmpHtml); } catch (_) {}
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0e1014", // matches --bg-deep so launch isn't a white flash
    title: "modal",
    // On macOS the dock icon comes from the packaged .icns; elsewhere set it here.
    icon: path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    autoHideMenuBar: false,
    // Frameless everywhere — the rail draws its own minimize/maximize/close
    // (see the .win-controls dots in index.html) so the window looks the
    // same on every platform instead of using each OS's own native chrome.
    // macOS still needs titleBarStyle: "hidden" (frame:false alone breaks
    // its rounded corners/shadow); the native traffic lights it draws for
    // that are hidden right after creation, below.
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hidden" : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs ipcRenderer; contextIsolation still protects the page
      spellcheck: true,
    },
  });

  if (process.platform === "darwin") mainWindow.setWindowButtonVisibility(false);

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("maximize", () => mainWindow.webContents.send("window:maximize-changed", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window:maximize-changed", false));

  // Open target=_blank / external http(s) links in the system browser,
  // never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Block in-window navigation to remote pages (the app is local-only);
  // route any such attempt to the browser instead.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const isLocal = url.startsWith("file://");
    if (!isLocal) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // The renderer debounces saves (see scheduleSave in index.html), so a save
  // can still be pending in memory — not yet even sent over IPC — when the
  // user closes the window. Hold the close, ask the renderer to flush that
  // pending save immediately, and only actually close once it acks (or the
  // ack times out, so a frozen renderer can't block quitting forever).
  closeAcked = false;
  mainWindow.on("close", (e) => {
    if (closeAcked) return;
    e.preventDefault();
    mainWindow.webContents.send("app:before-close");
    setTimeout(() => { closeAcked = true; if (mainWindow) mainWindow.close(); }, 1500);
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// Registered once (not per-window) to avoid stacking listeners across
// close/reopen cycles on macOS, where the app can stay alive with no windows.
let closeAcked = false;
ipcMain.on("app:close-ack", () => {
  closeAcked = true;
  flushStore().then(() => { if (mainWindow) mainWindow.close(); });
});

// Last-resort safety net (e.g. renderer never got to ack): persist whatever
// already made it into storeCache before the app fully exits.
app.on("before-quit", () => { if (storeCache) flushStore(); });

// Custom window controls — the page draws its own minimize/maximize/close
// (see .win-controls in index.html) since the window is frameless on every
// platform, so these are its only way to actually move the window state.
ipcMain.handle("window:minimize", () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window:close", () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle("window:is-maximized", () => !!(mainWindow && mainWindow.isMaximized()));

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Reveal Data File",
          click: async () => {
            if (storeFilePath && fs.existsSync(storeFilePath)) {
              shell.showItemInFolder(storeFilePath);
            } else if (storeFilePath) {
              shell.openPath(path.dirname(storeFilePath));
            }
          },
        },
        {
          label: "Reveal Daily Backups",
          click: async () => {
            if (backupsDir) {
              await fsp.mkdir(backupsDir, { recursive: true });
              shell.openPath(backupsDir);
            }
          },
        },
        { type: "separator" },
        {
          label: "Export Note as PDF…",
          click: () => { if (mainWindow) mainWindow.webContents.send("menu:export-pdf"); },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts (in app: press ?)",
          click: () => {
            if (mainWindow) {
              dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "Shortcuts",
                message: "modal uses Vim-style keys.",
                detail:
                  "Press  ?  inside the app (in Normal mode) to see the full list.\n\n" +
                  "Quick start:  i = type,  Esc = stop,  h j k l = move,  dd = delete line,  u = undo.",
                buttons: ["OK"],
              });
            }
          },
        },
        {
          label: "About modal",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About modal",
              message: "modal",
              detail:
                "A Vim-inspired note editor, gentled for everyday work.\n\n" +
                "Your notes are saved automatically to:\n" +
                (storeFilePath || "(initializing)"),
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  initStore();
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
