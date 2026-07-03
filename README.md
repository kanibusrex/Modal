# modal — standalone desktop app

A Vim-inspired note editor, gentled for everyday work, packaged as a standalone
[Electron](https://www.electronjs.org/) desktop application.

This wraps the original single-file `modal-notes.html` editor in a native window
and gives it **real, persistent storage on disk** so your notes survive restarts.

### Editor features added in this build

- **Copy buttons on code blocks.** In the rendered preview, hovering any fenced
  code block reveals a small `⧉ Copy` button that copies the block's exact
  contents to the clipboard (it briefly confirms with `✓ Copied`).
- **Save a note as Markdown.** Export the current note to a `.md` file via the
  file menu ("Save this note as .md…") or the Vim-style commands `:saveas` /
  `:w <name>`. Any in-app images are embedded as data URIs so the exported file
  is self-contained.
- **Open `.md` files.** Bring Markdown (or `.txt`) files in as notes via the
  file menu ("Open .md file…") or the Vim-style commands `:open` / `:e`. You can
  select several at once. Images embedded as data URIs (including ones written
  by the save-as-md feature above) are absorbed back into the app's image store,
  so the note text stays clean and the pictures render and re-export normally.
- **Tab between notes while reading.** In preview mode, `Tab` jumps to the next
  note and `Shift+Tab` to the previous one, following the sidebar's order (and
  respecting the search filter, if one is active). It wraps around at the ends.
- **Email the current note (SMTP).** Send a note as a real email straight from
  the app via the File menu ("Email This Note…", `Cmd/Ctrl+Shift+M`) or the
  Vim-style commands `:mail` / `:email`. The note is rendered to an **HTML email
  with its images inlined** (as `cid:` attachments), so pictures arrive intact.
  A compose dialog lets you set the recipient and subject (pre-filled with the
  note's title) before sending.
  - **One-time setup:** File → "Email Settings…" (or `:mailsetup`) to enter your
    SMTP host, port, username, password, and from-address. Works with Gmail (use
    an [app password](https://support.google.com/accounts/answer/185833)),
    Fastmail, Outlook, or any SMTP server. "Test connection" verifies it.
  - **Credentials never leave your machine.** The password is encrypted with the
    OS keychain via Electron's `safeStorage` and stored in
    `modal-smtp.json` (in the same app-data folder as your notes), separate from
    the notes file so it's never included in exports. On a system with no
    keychain backend, the app warns and stores it unencrypted as a fallback.
  - If SMTP isn't configured, the email commands open the settings dialog first.
- **Fetch incoming email as notes (IMAP).** Pull your latest inbox messages
  into modal via the File menu ("Fetch Email (Inbox)…") or the Vim-style
  commands `:fetch` / `:inbox`. Each message is parsed and imported as a
  read-only **note** (subject as the title, with From/Date and the body text).
  **Image attachments are pulled into the note's images** (stored in the app's
  image store and shown inline in preview / re-exported with the note); other
  attachments are listed by name and size. Already-imported messages are skipped
  on re-fetch (deduped by Message-ID). Reading is non-destructive — messages are
  **not** marked as read on the server. To reply, just use "Email This Note…" on
  the imported note.
  - Receiving reuses your sending username and password; the IMAP host/port live
    in the same Settings dialog (prefilled `imap.gmail.com` : `993`, SSL). For
    Gmail, the same app password works, and IMAP must be enabled in Gmail (it is
    by default for most accounts).


## Run it

You need [Node.js](https://nodejs.org/) (v18 or newer) installed.

```bash
cd modal-app
npm install      # downloads Electron (a one-time ~100 MB download)
npm start        # launches the app
```

## Build installers (optional)

To produce a double-clickable app / installer for your platform:

```bash
npm run dist          # builds for the platform you're currently on
# or target one explicitly:
npm run dist:mac      # .dmg + .zip   (must be run on macOS)
npm run dist:win      # .exe installer + portable  (best run on Windows)
npm run dist:linux    # AppImage + .deb
```

Output lands in the `release/` folder. Note that, due to OS code-signing,
each platform's installer is best built **on that platform** (or in CI).

## How your notes are stored

The editor was originally written against a host-provided `window.storage`
key/value API. This app re-implements that exact interface, backed by a JSON
file on disk:

| Platform | Location |
|----------|----------|
| macOS    | `~/Library/Application Support/modal/modal-store.json` |
| Windows  | `%APPDATA%\modal\modal-store.json` |
| Linux    | `~/.config/modal/modal-store.json` |

Use **File → Reveal Data File** in the menu to open this location. Writes are
debounced and atomic (temp file + rename), so an interrupted save can't corrupt
your notes. Because storage is a real file rather than the browser's
`localStorage`, pasted/dropped images (stored inline as base64) are handled
without hitting any size cap.

The app's separate "link to a file and autosave" feature (the file menu inside
the editor) uses the File System Access API, which works natively in Electron —
so you can still mirror your notes to a `.json` file anywhere you choose.

## Project layout

```
modal-app/
├── index.html   # the editor, copied verbatim — no app logic was changed
├── main.js      # Electron main process: window, menus, file-backed storage
├── preload.js   # exposes window.storage to the page (securely, via contextBridge)
├── build/       # app icons (icon.svg source + icon.png / .ico / .icns)
└── package.json # scripts + electron-builder config
```

## The icon

The app icon lives in `build/` as `icon.png` (1024²), `icon.ico` (Windows,
16–256px), and `icon.icns` (macOS, through 1024px), all generated from the
editable source `build/icon.svg`. The design carries over the editor's own
visual signature — the amber gutter markers (which double as a Vim-style `:`
command prompt) beside the glowing cyan→purple block cursor. electron-builder
picks these up automatically when you run `npm run dist`.

To tweak it, edit `build/icon.svg` and re-export, e.g.:

```bash
pip install cairosvg pillow
python3 - <<'PY'
import cairosvg; from PIL import Image
cairosvg.svg2png(url='build/icon.svg', write_to='build/_hi.png', output_width=2048, output_height=2048)
m = Image.open('build/_hi.png').convert('RGBA').resize((1024,1024), Image.LANCZOS)
m.save('build/icon.png')
m.save('build/icon.ico', sizes=[(s,s) for s in (16,24,32,48,64,128,256)])
m.save('build/icon.icns')
PY
```

## Notes

- **Offline:** the editor links to JetBrains Mono from Google Fonts. With no
  network it falls back gracefully to your system monospace font (SF Mono /
  Consolas / Menlo). To make it fully self-contained, download the font and
  point the `<link>` in `index.html` at a local copy.
- **Security:** the renderer runs with `contextIsolation: true` and
  `nodeIntegration: false`. The page can't touch Node directly — it only sees
  the three storage functions exposed in `preload.js`. External `http(s)` links
  open in your default browser rather than inside the app.
- **Shortcuts:** press `?` inside the app (in Normal mode) for the full list.
  Quick start: `i` to type, `Esc` to stop, `h j k l` to move, `dd` to delete a
  line, `u` to undo.
