# The desktop app

Vanilla Accounting as a Mac app (ADR 0006, form 3): one window on the same UI and the same engine
as `npm start`, with no terminal, Node.js or Homebrew needed. The code is in `src/desktop/`.

## How it is built

| Part | File | What it does |
|---|---|---|
| Main process | `src/desktop/main.ts` | One instance; starts the server on 127.0.0.1; opens the window; the native menu; window place, port, last books and the phone's pairing in `desktop.json` of the user data folder. |
| Server | `src/desktop/server.ts` | `/api/desktop` (the start screen's routes, the phone's switch), the built UI, and the books API (`src/server/api.ts`) once books are open. Opening other books switches the API in place. Requests naming another host are refused. Switched on, a second listener for the phone (below). |
| Background | `src/server/background.ts` | Shared with `npm start`: files arriving in the inbox (phone, drop, Finder) start their runs, at start for what waited and every 5 s after; the workflows' minute clock. Started once claude is known. |
| Start screen | `src/app/desktop/StartScreen.tsx` | At `/start` and whenever no books are open: open a folder, set up new books (the questions of `npm run init`, checked by `src/workspace/create.ts`), or open a copy of the demo. |
| Preload | `src/desktop/preload.ts` | The page's only bridge, `window.vanilla`: the folder dialogs (open a folder; the save panel that names the folder of new books, `src/desktop/new-folder.ts`), saving a PDF, menu commands (zoom), the UI language for the menu. Context isolation and the sandbox are on; the page has no Node. Its channels are the table `src/desktop/channels.ts`, which the main process answers from too; `tests/desktop-channels.test.ts` fails when one side uses a channel the other does not. A call that fails reaches the page as a `DesktopCallError` (`src/app/desktop/bridge.ts`), which `errorText` says in a plain sentence. |
| Start | `src/desktop/start.ts` | The offer to move into the Applications folder (after a move Electron quits this process and starts the moved app: nothing more starts here), and the window a click on the Dock icon brings up: a new one when none is left, the hidden one when its first paint did not come within `PAINT_GRACE_MS` or its page failed to load; both listeners stand before the start's first `await`. A start that fails says so in a dialog and ends. |
| PDFs | `src/desktop/print.ts` | Invoice and report PDFs printed by Electron's own Chromium in a hidden window (ADR 0012), so no browser has to be installed. `npm start` and the CLI keep printing with puppeteer-core. |
| The AI's programs | `src/platform/ai-cli.ts`, `src/platform/login-path.ts` | Claude Code (`claude`) and Codex (`codex`) are looked for on the PATH, the person's login shell's included (an app from the Finder gets PATH `/usr/bin:/bin`), and in `~/.local/bin`, where the makers' installers write; each look asks again, so nothing needs a restart. The app sets them up with the maker's installer and never reads a login ([0.4.0/ai-setup.md](0.4.0/ai-setup.md)). Without an AI, model features say that one is missing and offer the setup and the way by hand, the inbox job does the steps that need no model, and everything else works. |
| Passwords | `src/secrets/sealed-store.ts` | The SMTP password, sealed by Electron's `safeStorage` (its key is the keychain item "vanilla-accounting Safe Storage") into `secrets.json` in the user data folder, per books. Firma › E-Mail-Versand saves it there; under `npm start` it stays in `.env`. |
| What is packed | `desktop/not-packed.cjs` | puppeteer-core, the canvas binary pdf.js would load (@napi-rs/canvas) and playwright-core stay out, with every package only they need. The engine imports them only dynamically or from CLI code the bundle does not reach; `tools/desktop/build.mjs` fails when the bundle imports one at start. |
| Photos | `src/parsers/image-pdf.ts`, `src/parsers/smaller.ts` | A JPG, PNG or HEIC in the inbox becomes a one-page PDF, turned upright by its EXIF orientation; HEIC is decoded by `/usr/bin/sips`. An own photo or the phone's scan is made smaller before it gets its id: each large JPEG in it is scaled to 3000 pixels on its long side at quality 75, by `sips` as well; a received PDF, a signed or encrypted one stays byte for byte. |
| Mail app | `src/platform/sources/mac-mail.ts` | The `mac-mail` channel for a source over one account of the Mail app (none is set up by the app yet, ADR 0015): the app asks Mail through `/usr/bin/osascript` (JavaScript for Automation) for its accounts, new messages and their attachments; no Full Disk Access. macOS asks once whether the app may control Mail, with the text of `NSAppleEventsUsageDescription`; the hardened runtime needs the entitlement `com.apple.security.automation.apple-events`. The app's own source code runs in the app's process (`inProcessLauncher`), since the fenced child cannot start in the Mac app yet. Contract and limits: `docs/0.4.0/mail-channels.md`. |
| Dictation | `src/desktop/dictation.swift`, `src/desktop/dictation.ts` | The chat's microphone (issue #150). The browser's Web Speech API fails in Electron, so the app ships its own recognizer: `Contents/MacOS/vanilla-dictation`, a Swift program built by `tools/desktop/build.mjs` with `swiftc` (Xcode command line tools) for Apple silicon and Intel. The main process starts one run per dictation and reads its JSON lines (`DictationEvent`); the page reaches it through `window.vanilla.dictate`, present only when the program was found. It captures the microphone with AVAudioEngine and recognizes on the Mac: from macOS 26 with SpeechAnalyzer (de-CH, fr-CH, it-CH, en-US; a language's model is fetched from Apple once, shown as «Lädt die Spracherkennung»), before that with SFSpeechRecognizer and `requiresOnDeviceRecognition`, only where Dictation has the language's model (de-CH, fr-CH, it-CH fall back to de-DE, fr-FR, it-IT); otherwise the button says why and nothing goes online. No audio and no text leave the Mac. macOS asks once for the microphone (`NSMicrophoneUsageDescription`) and, before macOS 26, for speech recognition (`NSSpeechRecognitionUsageDescription`); the program carries the same texts in its own `__info_plist`. Signed, the hardened runtime needs `com.apple.security.device.audio-input`. `vanilla-dictation --lang de-CH --file a.aiff` recognizes a file, for a check without a microphone (`say -v Anna -o a.aiff …`). |

## Documents, Desktop, Downloads

macOS asks the person before an app reads its Documents, Desktop or Downloads folder, iCloud Drive
(`~/Library/Mobile Documents`) or a volume (`/Volumes`: a USB stick, a network share), and holds
that first read until she answers «Erlauben» or «Nicht erlauben» (issue #373). So the app touches
none of them until a step of hers needs it, and says just before why macOS will ask:

- A first start reads nothing there. GET /api/desktop never lists the Documents folder; the menu's
  «Zuletzt geöffnet» takes its names from `desktop.json` (`names`), not from the folders.
- «Neue Buchhaltung erstellen» first says why macOS will ask and that «Erlauben» is needed
  («Weiter», or «Anderen Ordner wählen»: the save panel or folder dialog in the home folder).
  «Weiter» reads the folder (GET /api/desktop/folders), so macOS asks over those words. The answer
  is kept in `desktop.json` (`access.documents`; 0.4.1 wrote it as `homeAccess`) with the app's
  version: a hint only, since an update (an unsigned build above all) may lose the permission, so
  another version says the words again. Every asynchronous look (`reach`) keeps macOS's answer for
  the folder it lies in the same way (`access.<folder>`; a folder's own rights are no answer).
  Once `allowed` the step reads the folder without a word, for a name not taken; after `refused`
  (EPERM) it names the way in System Settings and offers «Nochmals versuchen»; a folder whose own
  rights refuse the app (EACCES, `locked`) is said apart, with the Finder's «Informationen». The
  form reads the folder itself where this version was allowed, and says the words under its folder
  field otherwise.
- POST /api/desktop/create never opens books or a setup already in the folder it is given: it
  refuses with `folderTaken` and the free name beside it («… 2»), which the form takes.
- Every look into a folder the person names or opened before starts with one asynchronous read
  (`DesktopServer.reach`, fs/promises), so macOS's question holds a worker thread, never the main
  process; the synchronous reads of opening books come after its answer. A folder the app may not
  read is refused as `folderRefused` (`why`: `privacy` or `rights`), and shown in the start
  screen's list with its name from `desktop.json` and «Kein Zugriff».
- Books in such a folder that this version of the app has no answer for (`DesktopServer.answered`
  false: the first start after an update) are not looked at. `firstPage` (`src/desktop/start.ts`)
  shows the start screen with the words before macOS's question (`unaskedPath`: «Deine Buchhaltung
  … liegt im Ordner «Dokumente». Gleich fragt macOS …», with «Weiter»), GET /api/desktop lists them
  with `unasked` and their name from `desktop.json`, and a click on them in that list or in the
  menu's «Zuletzt geöffnet» shows the same words first. Only «Weiter» opens them, and macOS asks then.
- At a later start of a version macOS answered already, `firstPage` opens the books opened last
  before the window as before when their folder answers within `REACH_WAIT_MS`; when macOS asks
  anyway (a grant of the save panel that lasted one run), the window comes first with the start
  screen, which says that macOS asks about that folder and names the books (`askingPath`), and the
  books open after «Erlauben».
- The look for the AI's programs (`placesOf`, `programOn`) skips PATH entries in these folders.

Other questions of macOS, and when they come:

- Microphone and speech recognition: only on the chat's microphone button. While macOS has not
  asked about the microphone (`systemPreferences.getMediaAccessStatus`, through
  `window.vanilla.micAccess`), the click first says that macOS will ask twice and what for;
  «Weiter» starts the dictation.
- Automation of Mail («… möchte Mail steuern»): only for a source that reads the Mac's Mail app,
  at its «Prüfen» or its runs. Its «Prüfen» says before the first click that macOS will ask.
- Incoming connections (the firewall, when it is on): only when the phone is switched on in
  Firma › Handy, which says so (`phone.firewall`).
- The keychain (`safeStorage`): read when a stored password or key is used. An unsigned build is
  a new app to the keychain after each update, so macOS may ask for it again then; a build signed
  with a Developer ID keeps every answer across updates (see «Signing, notarization, updates»).

`tests/desktop-protected-folders.test.ts` records every `node:fs` call under these folders
(`tests/support/protected-folders.ts`) while the server does what the start and the first screen
do, and holds the asynchronous ones as macOS does while it asks.

## Receipts from the phone

The receipt app on the iPhone (`ios/`) and the scan page (`/scan`) send photos into the open
books' inbox, where the background run reads them like a drop. The phone pairs once, by scanning
a QR code the Mac shows in Firma › Handy.

**Security model.** The books API listens on 127.0.0.1 only, behind its host guard, as before;
nothing of it is on the network. The phone gets its own listener, and only while a person has
switched it on in Firma › Handy (off by default, and off again with one click):

| | |
|---|---|
| Listener | `0.0.0.0:<phone port>`, its own port, chosen by the system the first time and kept in `desktop.json`, so a paired phone finds the Mac after a restart. Only when that port is taken does it change; the phone then scans the new code. |
| Paths | `GET /scan`, `GET /scan/manifest.json` (the page, no data), `GET /api/status`, `POST /api/upload`. Everything else answers 404 there (`phoneApp`, `src/server/phone.ts`). |
| Token | 32 random bytes (base64url), made when the access is first switched on and kept while it is off. `/api/status` and `/api/upload` need `Authorization: Bearer <token>`; without it, or with another, 401 `phoneToken`, checked before the body is read and compared in constant time (both sides hashed, `timingSafeEqual`). The books API checks it once more (`phoneGate`). «Neuen Code erstellen» replaces it: every phone paired so far is refused until it scans the new code. |
| QR code | `http://<address>:<port>/scan#token=<token>`: the Mac's first Wi-Fi or Ethernet address. The token is in the fragment, which a browser never sends; the scan page keeps it in the phone's local storage and removes it from the address. The receipt app keeps it in the iOS Keychain (this device only). |
| Storage | `desktop.json` in the user data folder, written readable by the user only (0600). Whoever can read it can already read the books. |
| Network | Plain HTTP on the local network: someone on the same Wi-Fi who reads the traffic could see the token and upload into the inbox, never read the books. An uploaded file goes through the inbox's checks like any drop (the same bytes, a copy by its facts). |

What the inbox does with a phone's file: the background run reads it as it arrives. The same
bytes sent twice (a retry) leave the inbox, and the run says «schon da»; a scan of a receipt the
books hold already (other bytes, the same facts) is linked to nothing, and Belege asks «möglicher
Doppelbeleg» (`src/intake/duplicates.ts`). A till receipt without a printed date takes the day
the phone took it (`X-Captured-At`, carried in the inbox name, `src/intake/captured.ts`), and its
detail says so.

macOS may ask once whether «Vanilla Accounting» may accept incoming connections; the access only
works after «Erlauben». Under `npm start` the server listens on every interface, and from the network only the phone's
paths answer: `/scan` without a token, `/api/status` and `/api/upload` only with the pairing
token (401 `phoneToken` otherwise; every other path 403 `localOnly`). The token is
`VANILLA_PHONE_TOKEN` from `.env`, or without it a new random one at each start
(`src/server/phone.ts`); the terminal prints the pairing link with it for every LAN address.

The port is kept from one start to the next, because the page stores theme, zoom and language
per origin. The page's zoom is its own (`src/app/shell/prefs.ts`); View › Vergrössern,
Verkleinern and Originalgrösse step it, and ⌘+ ⌘− ⌘0 still reach the page.

## Commands

    npm run desktop          # build the UI and the main process, then run the app from this checkout
    npm run desktop:dev      # the app from this checkout without a rebuild per change (below)
    npm run desktop:build    # release/Vanilla Accounting-<version>-arm64.dmg and -x64.dmg
    node tools/desktop/smoke.mjs "release/mac-arm64/Vanilla Accounting.app" .verify/evidence/release/b

`tools/desktop/build.mjs` bundles `src/desktop` into `out/desktop/` (two folders below the app
root, as `APP_ROOT` expects) and fails when the bundle imports a package that is not a
dependency in `package.json`, since only those are packed. The icon is the brand's: the wave in tram
blue (`assets/app-icons/macos/AppIcon.svg` and `AppIcon-1024.png` of the branding repository,
copied to `desktop/icon.svg` and `desktop/icon.png`; its `web/` set is `public/favicon*` and
`apple-touch-icon.png`; its `ios/` icon is the phone app's AppIcon set). `node tools/brand/icons.mjs
<branding repo>` copies them all, renders the phone sizes and pins each file's hash in
`desktop/brand-icons.json`; the hashes it replaces become `retired`. tests/brand-icons.test.ts and
`desktop:build` refuse an icon that is not pinned or a retired one anywhere in the repository, so
the old receipt icon cannot come back through a merge.

**Run it in a VM, never on your own desktop:** `npm run desktop:e2e` installs the built app into
the Tart VM `vanilla-e2e` over the copy there (as an update would) and runs the smoke test inside
it, with no window on the host; `-- --fresh` uses a throwaway clone of `vanilla-clean` for a first
installation, `-- --watch` shows the VM in a window. `tools/desktop/vm-e2e.sh` says what it needs
(an SSH key installed once). The evidence comes back to `/tmp/vanilla-e2e/out/`.

The smoke test starts the packaged app with only `/usr/bin:/bin` on its PATH and a fresh user data
folder (so it never opens books of the machine), and drives it: start screen, Demo, every area,
issuing an invoice (one page, the QR-bill decodes), the SMTP password saved in Firma and the
invoice sent to a local SMTP server (the attachment's hash is the stored PDF's), a PDF, a PNG and
a HEIC dropped and read by the inbox job, a camt.053 that pays the invoice, new books (committed
to git), File › Demo through the menu, a restart, and a start without claude. claude is
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

## Dev mode

`npm run desktop:dev` (`tools/desktop/dev.mjs`) runs the app from this checkout and keeps it
current while you edit. It is one command; Ctrl+C ends it, and so does quitting the app.

| You change | What happens |
|---|---|
| `src/app/**` (components, CSS, the dictionaries) | Vite's HMR updates the page in the window. A component swaps in place; a file that is not a component, such as a dictionary, reloads the page. Electron keeps running. |
| a file the main process bundles outside `src/app` (`src/desktop`, `src/server`, the engine) | esbuild rebuilds `out/desktop/` and the runner restarts Electron. The window reopens where it was, on the books opened last. |
| anything else, or the menu's words (they come from the dictionaries) | type `rs` and Enter in the terminal to restart Electron by hand. |

The window loads the desktop server as in the packed app, so `/start`, the app's paths, the
books API, `/api/desktop`, the host check and the preload's bridge are the same. Only the server's
answer to a request that is no API changes: in dev it comes from the Vite dev server the runner
starts (`devUi` in `src/desktop/server.ts`), not from `dist/`. Vite's HMR socket goes to Vite
directly. Electron is in a process group of its own; a restart or the end sends it SIGTERM, which
it answers with `app.quit()`, then removes whatever of the group is left (helpers, the login shell
of the PATH lookup), with SIGKILL after 5 seconds. The runner stops nothing outside that group.

Dev mode does not share anything with the installed app, so both can run side by side:

- The user data folder is `~/Library/Application Support/vanilla-accounting-dev` (recent list,
  `desktop.json`, the demo copy, the single-instance lock). Set `VANILLA_DEV_USER_DATA` to use
  another folder, for example a fresh one for a test.
- The window's server listens on 127.0.0.1:5192, Vite on 127.0.0.1:5191 (or the next free port).
  `npm start` uses 5173 and 3456, and the installed app keeps its own port.
- Electron starts with Chromium's `--use-mock-keychain`, so dev never reads or writes the keychain
  item "vanilla-accounting Safe Storage". An SMTP password saved in dev is sealed with a test key.
- The window shows a DEV badge at the top, its title starts with «DEV ·», and the Dock icon carries
  «DEV».

Electron starts with the PATH an app opened from the Finder has (`/usr/bin:/bin:/usr/sbin:/sbin`),
so `claude` and `codex` are found through the login shell as in the packed app. Arguments after
`--` go to Electron, for example `npm run desktop:dev -- --remote-debugging-port=9339`.

Dev mode is active only when the runner sets both `VANILLA_DEV_UI` and `VANILLA_DEV_USER_DATA`,
and never in a packed app (`app.isPackaged`), whatever its environment says. `npm run desktop`,
`desktop:dir` and `desktop:build` set neither and run as before.

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

An unsigned app is refused by Gatekeeper on another Mac the first time: the person opens it once,
clicks **Done**, then clicks **Open Anyway** next to "Vanilla Accounting was blocked" in System
Settings › Privacy & Security. A signed and notarized one opens with a double-click.
