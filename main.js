// main.js — Electron main process for "modal"
//
// Responsibilities:
//   1. Create the application window and load the note editor (index.html).
//   2. Back the renderer's `window.storage` API with a real file on disk
//      (in the OS per-user app-data directory) via IPC. This replaces the
//      artifact host's storage so notes — including pasted images stored as
//      base64 — persist across launches without the ~5MB localStorage limit.
//   3. Provide a native menu and send external links to the system browser.

const { app, BrowserWindow, Menu, shell, ipcMain, dialog, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

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
let storeCache = null;        // in-memory mirror: { [key]: string }
let writeTimer = null;
let writePromise = Promise.resolve();

function loadStoreFromDisk() {
  try {
    const raw = fs.readFileSync(storeFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {}; // missing or unreadable -> start empty
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
  storeCache = loadStoreFromDisk();
  // SMTP settings live in their own file so credentials never sit in the
  // notes JSON (which the user can reveal/export).
  smtpConfigPath = path.join(app.getPath("userData"), "modal-smtp.json");
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

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
// Two paths:
//   1. mail:compose — hand a mailto: URL to the OS mail client (no account).
//      Used as the fallback when SMTP isn't configured.
//   2. SMTP direct send via nodemailer — the app sends mail itself, so it can
//      deliver an HTML body with inline images. Credentials live in a separate
//      file in userData; the password is encrypted with the OS keychain via
//      Electron's safeStorage and never written in plaintext or returned to
//      the renderer.

// --- mailto fallback ---
ipcMain.handle("mail:compose", (_evt, subject, body) => {
  const s = encodeURIComponent(String(subject == null ? "" : subject));
  const b = encodeURIComponent(String(body == null ? "" : body));
  shell.openExternal("mailto:?subject=" + s + "&body=" + b);
  return true;
});

// --- SMTP config storage (password encrypted at rest) ---
let smtpConfigPath = null;   // resolved in initStore alongside the note store

function readSmtpConfigRaw() {
  try {
    const raw = fs.readFileSync(smtpConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Decrypt the stored password, tolerating a machine where encryption isn't
// available (then it was stored as a plaintext fallback, flagged on disk).
function decryptStoredPassword(cfg) {
  if (!cfg) return "";
  if (cfg.passwordPlain != null) return String(cfg.passwordPlain);
  if (cfg.passwordEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(cfg.passwordEnc, "base64"));
    } catch (e) {
      console.error("modal: could not decrypt SMTP password:", e);
      return "";
    }
  }
  return "";
}

// What the renderer is allowed to see — never the password itself.
function publicSmtpConfig() {
  const cfg = readSmtpConfigRaw();
  return {
    host: cfg.host || "",
    port: cfg.port || 587,
    secure: !!cfg.secure,
    user: cfg.user || "",
    from: cfg.from || "",
    lastTo: cfg.lastTo || "",
    // Receiving (IMAP). Shares the username + password with sending.
    imapHost: cfg.imapHost || "",
    imapPort: cfg.imapPort || 993,
    imapSecure: cfg.imapSecure !== false,
    hasPassword: !!(cfg.passwordEnc || cfg.passwordPlain != null),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
}

ipcMain.handle("smtp:getConfig", () => publicSmtpConfig());

// Save config. If `password` is a non-empty string we (re)store it; if it's an
// empty string we keep whatever was saved before (so the user needn't retype
// it just to tweak the host). Returns the public view.
ipcMain.handle("smtp:saveConfig", (_evt, incoming) => {
  const prev = readSmtpConfigRaw();
  const cfg = {
    host: String((incoming && incoming.host) || "").trim(),
    port: Number((incoming && incoming.port) || 587),
    secure: !!(incoming && incoming.secure),
    user: String((incoming && incoming.user) || "").trim(),
    from: String((incoming && incoming.from) || "").trim(),
    lastTo: String((incoming && incoming.lastTo) || prev.lastTo || "").trim(),
    imapHost: String((incoming && incoming.imapHost) || "").trim(),
    imapPort: Number((incoming && incoming.imapPort) || 993),
    imapSecure: incoming && incoming.imapSecure != null ? !!incoming.imapSecure : true,
  };
  const newPassword = incoming && typeof incoming.password === "string" ? incoming.password : "";
  if (newPassword) {
    if (safeStorage.isEncryptionAvailable()) {
      cfg.passwordEnc = safeStorage.encryptString(newPassword).toString("base64");
    } else {
      // No OS keychain backend (e.g. some Linux setups) — store as plaintext
      // but mark it so we can warn the user in the UI.
      cfg.passwordPlain = newPassword;
    }
  } else {
    // Preserve the previously saved password.
    if (prev.passwordEnc) cfg.passwordEnc = prev.passwordEnc;
    if (prev.passwordPlain != null) cfg.passwordPlain = prev.passwordPlain;
  }
  try {
    const tmp = smtpConfigPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, smtpConfigPath);
    try { fs.chmodSync(smtpConfigPath, 0o600); } catch (e) {}
  } catch (e) {
    console.error("modal: failed to save SMTP config:", e);
    return { ok: false, error: "Could not save settings to disk." };
  }
  return { ok: true, config: publicSmtpConfig() };
});

function buildTransport() {
  const cfg = readSmtpConfigRaw();
  if (!cfg.host) return { error: "No SMTP server configured." };
  const password = decryptStoredPassword(cfg);
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure, // true for 465; false uses STARTTLS on 587
    auth: cfg.user ? { user: cfg.user, pass: password } : undefined,
  });
  return { transport, cfg };
}

// Verify host/port/credentials without sending anything.
ipcMain.handle("smtp:test", async () => {
  const { transport, error } = buildTransport();
  if (error) return { ok: false, error };
  try {
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Send a message. `payload` = { to, subject, html, text, attachments } where
// each attachment is { cid, filename, dataUri }. Inline images are referenced
// from the HTML as cid:<cid>.
ipcMain.handle("mail:send", async (_evt, payload) => {
  payload = payload || {};
  const to = String(payload.to || "").trim();
  if (!to) return { ok: false, error: "No recipient address." };

  const { transport, cfg, error } = buildTransport();
  if (error) return { ok: false, error };

  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.map((a) => {
        // data:<mime>;base64,<data>
        const m = /^data:([^;]+);base64,(.*)$/.exec(String(a.dataUri || ""));
        if (!m) return null;
        return {
          cid: a.cid,
          filename: a.filename || (a.cid + ".png"),
          content: Buffer.from(m[2], "base64"),
          contentType: m[1],
        };
      }).filter(Boolean)
    : [];

  // Thread replies correctly when the caller supplies the original Message-ID.
  const inReplyTo = payload.inReplyTo ? String(payload.inReplyTo) : "";

  try {
    await transport.sendMail({
      from: cfg.from || cfg.user,
      to,
      subject: String(payload.subject || "(no subject)"),
      text: String(payload.text || ""),
      html: payload.html ? String(payload.html) : undefined,
      attachments,
      inReplyTo: inReplyTo || undefined,
      references: inReplyTo || undefined,
    });
    // Remember the recipient for next time (convenience only).
    try {
      const raw = readSmtpConfigRaw();
      raw.lastTo = to;
      fs.writeFileSync(smtpConfigPath, JSON.stringify(raw), { encoding: "utf8", mode: 0o600 });
    } catch (e) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

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

// --- IMAP: fetch the most recent INBOX messages ---
// Read-only: we open the mailbox without marking anything seen, parse each
// message, and return a plain-data array. The renderer turns them into notes.
ipcMain.handle("imap:fetch", async (_evt, opts) => {
  opts = opts || {};
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 25, 1), 100);
  const cfg = readSmtpConfigRaw();
  // Fall back to Gmail's IMAP host if only the (Gmail) SMTP side was filled in.
  const host = cfg.imapHost || (cfg.host === "smtp.gmail.com" ? "imap.gmail.com" : "");
  if (!host) return { ok: false, error: "No IMAP server configured (set it in Email Settings)." };
  if (!cfg.user) return { ok: false, error: "No username configured." };

  const client = new ImapFlow({
    host,
    port: Number(cfg.imapPort) || 993,
    secure: cfg.imapSecure !== false,
    auth: { user: cfg.user, pass: decryptStoredPassword(cfg) },
    logger: false,
  });

  try {
    await client.connect();
    const messages = [];
    // readOnly so messages aren't flagged \Seen just by fetching them.
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const total = (client.mailbox && client.mailbox.exists) || 0;
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(start + ":*", { envelope: true, source: true })) {
          let parsed;
          try { parsed = await simpleParser(msg.source); } catch (e) { parsed = null; }
          const env = msg.envelope || {};
          const addrText = (a) => Array.isArray(a) ? a.map((x) => x.name ? `${x.name} <${x.address}>` : x.address).join(", ") : "";
          const date = (parsed && parsed.date) || env.date || new Date();
          messages.push({
            uid: msg.uid,
            messageId: (parsed && parsed.messageId) || env.messageId || ("seq-" + msg.seq),
            subject: (parsed && parsed.subject) || env.subject || "(no subject)",
            from: (parsed && parsed.from && parsed.from.text) || addrText(env.from) || "",
            to: (parsed && parsed.to && parsed.to.text) || addrText(env.to) || "",
            date: date instanceof Date ? date.toISOString() : String(date),
            text: (parsed && parsed.text) || (parsed && parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim() : ""),
            attachments: ((parsed && parsed.attachments) || []).map((a) => {
              const isImage = /^image\//i.test(a.contentType || "");
              const att = {
                filename: a.filename || (a.cid ? "inline-image" : "attachment"),
                contentType: a.contentType || "",
                inline: a.contentDisposition === "inline" || !!a.related,
                size: a.size || (a.content ? a.content.length : 0),
              };
              // Embed images (only) as data URIs so the note can render them;
              // skip very large ones to keep the note store reasonable.
              if (isImage && a.content && a.content.length <= 15 * 1024 * 1024) {
                att.dataUri = "data:" + (a.contentType || "image/png") + ";base64," + a.content.toString("base64");
              }
              return att;
            }),
          });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    messages.reverse(); // newest first
    return { ok: true, messages };
  } catch (e) {
    try { await client.logout(); } catch (_) {}
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs ipcRenderer; contextIsolation still protects the page
      spellcheck: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

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

  mainWindow.on("closed", () => { mainWindow = null; });
}

// Persist any pending changes before the app fully exits.
app.on("before-quit", () => { if (storeCache) flushStore(); });

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
        { type: "separator" },
        {
          label: "Email This Note…",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => { if (mainWindow) mainWindow.webContents.send("menu:email-note"); },
        },
        {
          label: "Fetch Email (Inbox)…",
          click: () => { if (mainWindow) mainWindow.webContents.send("menu:fetch-mail"); },
        },
        {
          label: "Email Settings…",
          click: () => { if (mainWindow) mainWindow.webContents.send("menu:email-settings"); },
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
