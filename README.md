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

## Download & install

Grab the latest installer for your platform from the
[**Releases**](https://github.com/kanibusrex/Modal/releases/latest) page:

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `modal-<version>-arm64.dmg` |
| macOS (Intel) | `modal-<version>.dmg` |
| Windows (installer) | `modal.Setup.<version>.exe` |
| Windows (portable) | `modal.<version>.exe` |
| Linux (AppImage) | `modal-<version>.AppImage` |
| Linux (Debian/Ubuntu) | `modal-notes_<version>_amd64.deb` |

> **These builds are not code-signed**, so your OS will warn on first launch.
> The app is fine — the warning just means it wasn't signed with a paid
> developer certificate.

**macOS** — if you see *"modal is damaged and can't be opened"*, that's
Gatekeeper blocking an unsigned, quarantined app. Drag **modal** into your
Applications folder, then run this once in Terminal to clear the quarantine
flag:

```bash
xattr -dr com.apple.quarantine /Applications/modal.app
```

Then open it normally. (Right-click → **Open** works for the milder
*"unverified developer"* warning, but the *"damaged"* variant on Apple Silicon
needs the `xattr` step above.)

**Windows** — if SmartScreen appears, click **More info → Run anyway**.

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
