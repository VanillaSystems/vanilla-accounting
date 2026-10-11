# The desktop app

Vanilla Accounting as a Mac app (ADR 0006, form 3): one window on the same UI and the same engine
as `npm start`, with no terminal, Node.js or Homebrew needed. The code is in `src/desktop/`.

## How it is built

| Part | File | What it does |
|---|---|---|
| Main process | `src/desktop/main.ts` | One instance; starts the server on 127.0.0.1; opens the window; the native menu; window place, port and last books in `desktop.json` of the user data folder. |
| Server | `src/desktop/server.ts` | `/api/desktop` (the start screen's routes), the built UI, and the books API (`src/server/api.ts`) once books are open. Opening other books switches the API in place. Requests naming another host are refused. |
| Start screen | `src/app/desktop/StartScreen.tsx` | At `/start` and whenever no books are open: open a folder, set up new books (the questions of `npm run init`, checked by `src/workspace/create.ts`), or open a copy of the demo. |
| Preload | `src/desktop/preload.ts` | The page's only bridge, `window.vanilla`: the folder dialog, menu commands (zoom), the UI language for the menu, and Claude: look for the CLI again, open the setup window. Context isolation and the sandbox are on; the page has no Node. |
| PDFs | `src/desktop/print.ts` | Invoice and report PDFs printed by Electron's own Chromium in a hidden window (ADR 0012), so no browser has to be installed. `npm start` and the CLI keep printing with puppeteer-core. |
| claude CLI | `src/desktop/claude.ts` | Found through the person's login shell (an app from the Finder gets PATH `/usr/bin:/bin`), else in `~/.local/bin` where the official installer puts it, before the window opens; only its path is taken (`CLAUDE_BIN`), and the inbox job uses it. Without it, model features point to Firma › Claude (`noClaude`), the inbox job does the steps that need no model, and everything else works. The page asks for it again each time the window gets the focus back while Claude is not ready, so a CLI installed meanwhile is used without a restart. |
| Claude einrichten | `src/desktop/claude-setup.ts`, `src/app/shell/claude.tsx` | See [Claude einrichten](#claude-einrichten). |
| Passwords | `src/secrets/sealed-store.ts` | The SMTP password, sealed by Electron's `safeStorage` (its key is the keychain item "vanilla-accounting Safe Storage") into `secrets.json` in the user data folder, per books. Firma › E-Mail-Versand saves it there; under `npm start` it stays in `.env`. |
| What is packed | `desktop/not-packed.cjs` | puppeteer-core, the canvas binary pdf.js would load, and the mail client of receipt collection (imapflow, mailparser) stay out, with every package only they need. The engine imports them only dynamically or from CLI code the bundle does not reach; `tools/desktop/build.mjs` fails when the bundle imports one at start. |
| Photos | `src/parsers/image-pdf.ts` | A JPG, PNG or HEIC in the inbox becomes a one-page PDF, turned upright by its EXIF orientation; HEIC is decoded by `/usr/bin/sips`. |

The port is kept from one start to the next, because the page stores theme, zoom and language
per origin. The page's zoom is its own (`src/app/shell/prefs.ts`); View › Vergrössern,
Verkleinern and Originalgrösse step it, and ⌘+ ⌘− ⌘0 still reach the page.

## Claude einrichten

Firma › Claude shows the state of the `claude` CLI (`GET /api/claude`): not installed, installed
but not signed in, or connected with its version. Signed in or not is `claude auth status`, which
reads the local credentials and makes no model call (a CLI too old for it counts as connected).
Belege shows "Claude einrichten" next to "Eingang verarbeiten" while Claude is not ready, and an
inbox job that ran without the model ends with a toast that leads there.

The app only starts the official installer, in a window the person sees; the installation and
the sign-in are theirs. It never installs anything out of sight and never handles the login. On
the Mac the button writes `claude-einrichten.command` into the user data folder and opens it with
`open`, which hands it to Terminal (no AppleScript, no automation permission). The script prints
what happens in the UI's language and in English, runs `curl -fsSL https://claude.ai/install.sh | bash`
when no `claude` is there yet, puts `~/.local/bin` on the window's PATH, runs `claude auth login`
unless `claude auth status` says it is signed in, and ends by telling the person to go back to the
app. On Windows the same is `claude-einrichten.ps1` (`irm https://claude.ai/install.ps1 | iex`),
started with `powershell.exe -NoExit -ExecutionPolicy Bypass -File` in a window of its own; it is
unit-tested as text and has not been run on Windows. `VANILLA_OPEN_COMMAND` replaces the opener
for a test run. In the browser (`npm start`) the app cannot open a window and shows the two
commands to copy.

Claude Desktop and the ChatGPT app put no CLI on the PATH: Claude Desktop keeps a private copy of
Claude Code in its own Application Support folder, ChatGPT keeps `codex` inside its app bundle.
The app does not use those copies (undocumented, versioned per release, signed in their own way).
When Claude Desktop is installed (`/Applications/Claude.app`) and no `claude` CLI is found,
Firma › Claude says so, so the person knows why the app still asks for Claude Code.

## Chat

⌘J opens the chat with Claude. The app has no dictation of its own and no page gets a device permission; macOS's dictation (Fn twice) types into the chat's field. See [chat.md](chat.md).

## Commands

    npm run desktop          # build the UI and the main process, then run the app from this checkout
    npm run desktop:build    # release/Vanilla Accounting-<version>-arm64.dmg and -x64.dmg
    node tools/desktop/smoke.mjs "release/mac-arm64/Vanilla Accounting.app" .verify/evidence/release/b

`tools/desktop/build.mjs` bundles `src/desktop` into `out/desktop/` (two folders below the app
root, as `APP_ROOT` expects) and fails when the bundle imports a package that is not a
dependency in `package.json`, since only those are packed. The app icon is
`desktop/icon.icns` (macOS), `desktop/icon.ico` (Windows) and `desktop/icon.png` (the About panel,
and the dock when the app runs unpacked), exported from the brand's finished files.

The smoke test starts the packaged app with only `/usr/bin:/bin` on its PATH and a fresh user data
folder (so it never opens books of the machine), and drives it: start screen, Demo, every area,
issuing an invoice (one page, the QR-bill decodes), the SMTP password saved in Firma and the
invoice sent to a local SMTP server (the attachment's hash is the stored PDF's), a PDF, a PNG and
a HEIC dropped and read by the inbox job, a camt.053 that pays the invoice, new books (committed
to git), File › Demo through the menu, a restart, and a start without claude: Firma › Claude says
it is missing, "Claude einrichten" writes the `.command` and hands it to a recorder instead of
`open` (no installer runs), and the stub put into `~/.local/bin` of a temporary home is found when
the window gets the focus back, and the refused model call then works. claude is
`tests/support/stub-bin/claude`, found through a login shell whose PATH holds it. Screenshots and
`smoke.json` go to the evidence folder. When the login keychain already holds the item
"vanilla-accounting Safe Storage" (an installed copy of the app made it), the smoke starts the app
with Chromium's `--use-mock-keychain` and checks that the item stays as it was: an unsigned
build of another signature would otherwise wait on macOS's prompt for it, and a test must not
change a person's keychain. [releasing.md](releasing.md) explains the prompt and how a release
is built, proven and published.

The release build is fused (`electronFuses` in the builder config): no `ELECTRON_RUN_AS_NODE`,
no `NODE_OPTIONS`, no `--inspect`, code only from `app.asar` with its hash checked, encrypted
cookies. So the smoke reaches the page through Chromium's `--remote-debugging-port`, and the
native menu through `window.vanillaSmoke`, which the preload exposes only when the app is started
with `--vanilla-smoke`. Both are command-line switches: a person opening the app from the Finder
has neither, and whoever can start it with switches could drive the page anyway.

## Signing, notarization, updates

`desktop/electron-builder.config.cjs` reads the environment:

| Variable | Effect |
|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | the Developer ID certificate (.p12) and its password: the app is signed. Without them it is not signed, even when the keychain holds an identity. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | with a signing certificate: the app is notarized. |
| `VANILLA_RELEASES` | `owner/repo` of the GitHub releases: the update feed written into the app, and the `.zip` files the updater installs from. |

The app checks for updates only when `package.json` has `"desktop": { "autoUpdate": true }`
(or `VANILLA_AUTO_UPDATE=1` is set), and only as a packaged app. Help › Dokumentation appears
when `package.json` has a `homepage`.

An unsigned app is refused by Gatekeeper on another Mac until the person allows it in System
Settings › Privacy & Security; a signed and notarized one opens with a double-click.
