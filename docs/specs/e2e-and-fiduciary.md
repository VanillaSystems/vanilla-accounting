# Spec: end-to-end tests for the phone and pairing, and the fiduciary loop

Status: draft for the owner, 2026-11-13. No code yet. Judged by [MISSION.md](../../MISSION.md),
[ADR 0015](../adr/0015-base-cases-in-the-app-long-tail-in-the-workspace.md) and
[ADR 0003](../adr/0003-deployment-and-collaboration.md) (local-first books in git, roles, hand-over,
history). Level 2 of issue #509 (personas through the real pipeline) is part A3.

The owner asked for two things on 2026-11-13:

- **A.** End-to-end tests for the phone and for pairing. Opt-in, so that a contributor who runs
  `npm test` never needs Xcode or the simulator.
- **B.** The fiduciary loop. The owner books everything and hands the books to an external
  fiduciary, who corrects what is wrong. The owner then sees what the fiduciary fixed and learns
  from it.

Each part starts with what exists today, then the proposal, then a phased plan with acceptance
checks. The open questions for the owner are at the end, each with a recommendation.

All people named here are made-up personas.

---

# Part A: end-to-end tests for the phone and for pairing

## A0. What exists today

**The phone app** (`ios/`, XcodeGen project `ios/project.yml`, target `Belege`, bundle id
`com.belege.receipts`, iOS 17, SwiftUI and SwiftData, German strings only):

| Screen / flow | File | What it does |
|---|---|---|
| Main list «Belege» | `ios/Belege/ContentView.swift` | Segmented picker «Zu senden (n)» / «Gesendet»; connection row («Mac verbunden», «Sucht den Mac …», banner «Mac nicht erreichbar» or «Noch nicht mit dem Mac verbunden»); bottom bar «Scannen» and the photo button «Fotos importieren» (`PhotosPicker`, at most 20); sync line «n warten · Jetzt senden» or «n warten · gehen, sobald der Mac da ist» |
| Document scan | `ScannerView.swift` | `VNDocumentCameraViewController` (VisionKit). Real camera only. |
| Note step | `ReceiptDetailView.swift` (`NoteStepView`) | «Notiz für die Buchhaltung» after a scan. The note stays on the phone (`PendingUpload.note`). |
| Settings | `SettingsView.swift` | «Mit dem Mac koppeln»: camera QR scanner (`PairingScannerView`, `DataScannerViewController`) **or the text field «oder den Koppel-Link einfügen»** + «Koppeln»; «Adresse des Macs (von Hand)» + «Prüfen und sichern»; the e-mail step after pairing (`EmailStepView`, «Weiter» / «Später») |
| Pairing | `Pairing.swift`, `ServerConnection.swift` | Parses `http://<address>:<port>/scan#token=<token>`. The token goes into the Keychain (`TokenStore`) and the address into `UserDefaults`. Then `GET /api/status` with `Authorization: Bearer`: 200 means connected, 401 means not paired, anything else means unreachable. |
| Upload | `UploadService.swift` | `POST /api/upload`, body = the PDF the phone made (`PDFCreator`), headers `Content-Type: application/pdf` and `X-Captured-At`. 200 marks it `synced`. 401 shows «nicht gekoppelt». Any other status shows «Fehler n». |
| Naming | `ReceiptRecognizer.swift`, `ReceiptNaming.swift` | On-device Vision OCR names the row («vorläufig»). `ios/NamingCheck/` checks the naming rules on the Mac. |

**The desktop side.** The phone's paths are `PHONE_ROUTES` in `src/server/phone.ts`:
`/scan`, `/scan/manifest.json`, `GET /api/status` (token) and `POST /api/upload` (token). The
upload route is `src/server/routes/scan.ts`. It writes the file into the inbox (`beleg-import/`)
under a `capturedStem` name. In the desktop app, Firma › Handy starts a second listener on
`0.0.0.0` that carries only those paths (`phoneApp`, `src/desktop/server.ts`). That listener
always checks the token. `npm start` instead serves them on its one port behind `phoneGate`,
which lets any request from this computer through without a token (`fromThisComputer`).

**Tests today.** Three test files simulate the phone from the host:
`tests/phone-intake.test.ts` (an upload through the desktop listener, read by the background run
with the stubbed `claude` from `tests/support/stub-bin/claude`, a copy flagged, the same bytes
sent twice), `tests/phone-access.test.ts` and `tests/phone-layout.test.ts`. The verify persona
`.claude/skills/verify/personas/phone-sync.md` sends HTTP requests the way the app does. The real
iOS app never runs in a test.

**Pairing tests today.** Unit and integration tests cover pairing: `pairing*.test.ts`,
`near-pairs-397*`, `number-match-426/456`, `pair-by-number-365`, `receipt-sets`, `match-sets-190*`.
`npm run eval:pairing` (`tools/eval/pairing.ts`) measures the matching chain on one workspace's
own links. It removes those links in memory and compares the chain's result with them, once with
code alone and once with an oracle in the model's place. No test runs a persona's files through
the whole pipeline against an answer key.

**What CI has.** One workflow exists: `.github/workflows/help-pages.yml`. No workflow runs tests.

**What reading `ios/` showed** (the simulator tests below will expose these; each is a finding,
not part of this spec's scope):

1. **Nothing sends by itself.** `ServerConnection.ping` runs only on `onAppear`, on pairing and
   on «Prüfen und sichern». Sending runs only on «Jetzt senden». The line «gehen, sobald der Mac
   da ist» therefore promises something no code does. When the Mac comes back, nothing happens
   until the person leaves the app and opens it again, then taps «Jetzt senden».
2. **Nothing is found on the network.** There is no Bonjour browse (`NSBonjourServices` is
   declared but unused). When the Mac's address changes (a new DHCP lease), the phone counts as
   unreachable until it is paired again.
3. **No accessibility identifiers.** UI tests would have to find elements by their German labels.
4. **The app is in German only.** Marco Rossi (Huber's employee, Italian is his first language)
   sees German.
5. **The note and the e-mail never reach the Mac.** The code comments say so ("phase 4").

## A1. iOS Simulator tests

### A1.1 What runs

A UI-test target drives the real app in the iOS Simulator against a real desktop server, with the
AI stubbed:

```
tools/ios/run.sh (npm run test:ios)
 ├─ preflight: macOS, xcodebuild, xcrun simctl, xcodegen, an iOS 17+ runtime   (refuse otherwise, A2.1)
 ├─ host: tools/ios/desktop-host.ts                       ── a copy of demo/ in $TMPDIR
 │     desktopServer (src/desktop/server.ts) as tests/phone-intake.test.ts starts it,
 │     CLAUDE_BIN = tests/support/stub-bin/claude, CLAUDE_STUB_ANSWER = the fixture receipt,
 │     phone switched on, writes { pairingUrl (LAN address), port, workspace } to a state file
 ├─ device: xcrun simctl create «vanilla-belege-test» (newest iPhone, newest iOS runtime), erase, boot
 │     xcrun simctl addmedia <udid> tests/ios/fixtures/*.jpg
 ├─ cd ios && xcodegen generate && xcodebuild build-for-testing -scheme Belege -destination id=<udid>
 ├─ phases: xcodebuild test-without-building -only-testing:BelegeUITests/<Phase>
 │     TEST_RUNNER_PAIRING_URL=… (xcodebuild passes TEST_RUNNER_* to the test process)
 │     between phases the script stops or starts the host (Mac off, Mac back, new pairing code)
 └─ check: tools/ios/check.ts reads the copy's books after each phase and asserts (A1.4)
```

**Pair through the phone listener's LAN address, never through `127.0.0.1`.** The simulator
shares the Mac's network. If the test pointed at the main port by a loopback name, `phoneGate`
would let it through without a token, and the token path would go untested. `desktop-host.ts`
takes the address from `lanAddresses()[0]` and the port from the phone listener, exactly as the
QR code shows them (`phoneInfo()`). If the Mac has no LAN address (no network at all), the script
refuses: «Kein Netzwerk: der Simulator erreicht den Mac nur über eine LAN-Adresse wie das
iPhone».

### A1.2 Changes to `ios/` that the tests need (test-only, no behaviour change)

- `ios/project.yml`: a target `BelegeUITests` (`type: bundle.ui-testing`, sources
  `BelegeUITests/`, dependency `Belege`), and a scheme `Belege` whose test action names it.
- `.accessibilityIdentifier` on what the tests touch, in English, never shown: `scan`,
  `importPhotos`, `sendNow`, `connectionRow`, `connectionBanner`, `settings`, `pairingCode`,
  `pairButton`, `manualURL`, `checkURL`, `emailLater`, `tabToSend`, `tabSent`, `uploadRow`
  (with the row's state as `accessibilityValue`: `waiting`, `sending`, `sent`).
- `ios/Belege/UITestHooks.swift`, compiled only under `#if DEBUG`, read from launch arguments:
  - `-uitest-reset`: empty the SwiftData store, the Documents folder, `serverURLString` and the
    Keychain item at launch, so that each phase starts as it says.
  - `-uitest-drop-first-ack`: `UploadService` treats the first 200 as lost (no `synced`), so the
    app sends the same bytes again. This is the true retry case: a reply lost on Wi-Fi.
  - `-uitest-import <file>`: import a file from the app container through the same
    `handlePhotos` → `savePending` path. **Use this only if** the out-of-process photo picker
    proves flaky in XCUITest (more than one failure in ten runs). The picker is tried first.
- `tools/ios/run.sh` builds Release once and refuses when its binary contains the string
  `-uitest-`. No hook may reach a shipped build.

### A1.3 The flows (one XCUITest class per phase, in `ios/BelegeUITests/`)

| Phase | Steps on the phone | Host between phases | Checked on the phone | Checked on the Mac (`check.ts`) |
|---|---|---|---|---|
| `P1Pairing` | launch with `-uitest-reset`; the banner «Noch nicht mit dem Mac verbunden» shows; tap it; paste the pairing URL into «oder den Koppel-Link einfügen»; «Koppeln»; the e-mail step: «Später»; «Fertig» | – | «Mac verbunden» | `GET /api/status` was called with the token; no upload yet |
| `P2Send` | «Fotos importieren»; pick the seeded receipt photo; the row shows «wartet aufs Senden»; tap «Jetzt senden» | – | the row moves to «Gesendet», «auf dem Mac» | the inbox received one PDF with the `X-Captured-At` stem. The background intake reads it (stubbed AI) and **links it to the demo payment the fixture was made for** (mapping to that ref). The receipt shows in the receipts area (`/api/receipts`). |
| `P3MacOff` | import a second photo | **stop the host** before the phase | banner «Mac nicht erreichbar», line «1 wartet · gehen, sobald der Mac da ist» | nothing arrived |
| `P4MacBack` | bring the app to the foreground (`XCUIDevice.shared.press(.home)` then `app.activate()`) and wait 15 s **without tapping** | **start the host** (same port and token, as the desktop keeps them in `desktop.json`) | the row reaches «Gesendet». **Today this fails** (finding A0.1); the test is written for the promise and marked `XCTExpectFailure` until the fix lands | the second receipt arrived |
| `P5DoubleSend` | (a) import **the same photo twice**: two PDFs whose bytes differ (PDF metadata); (b) relaunch with `-uitest-drop-first-ack`, import a third photo, «Jetzt senden» | – | (a) both rows «Gesendet»; (b) after the lost reply the row is still «wartet»; the second tap sends again | (a) the second is a possible copy («mögliche Kopie»), paid by nothing, one link only; (b) the same bytes twice give one receipt and a note in the run (as `tests/phone-intake.test.ts` proves on the host) |
| `P6NewCode` | «Jetzt senden» with one waiting | **new pairing code** at the host (Firma › Handy «Neuer Code»: a new token) | `UploadError.notPaired`: the alert «Senden hat nicht geklappt» names the cause, then the banner «Noch nicht mit dem Mac verbunden» | 401 with `code: 'phoneToken'`; nothing written |

The fixture photo `tests/ios/fixtures/receipt-<ref>.jpg` comes from `kit.mjs`'s `tillPhoto` for
one demo payment, together with the `CLAUDE_STUB_ANSWER` that reads it (date, amount, supplier).
Both are made-up demo data and are committed. The photo is rendered once by Chrome and never
during the test.

### A1.4 Host on the Mac, or the Mac app in a Tart VM

| | Host: `desktopServer` on the host (default) | VM: the packed Mac app in Tart (`vm.sh up`) |
|---|---|---|
| What it proves | the real phone listener (`phoneApp` on `0.0.0.0`), the token, the upload route, the intake, pairing | additionally: the dmg, Electron, the bundled server, Firma › Handy's switch and QR card as built, a second Mac on the network |
| Time | about 3 min (`xcodebuild` dominates), about 1 min with the build cached | dmg build about 3 min, VM about 1 min, then the same phases |
| CI | yes (macOS runner) | no: GitHub's runners cannot nest Tart |
| Load | the simulator plus one node process | the simulator plus one VM (A2.4) |
| Reachability | the LAN address of the host | the VM's address on Tart's NAT network (`tart ip`), which the host's simulator reaches |

**Recommendation:** run on the host by default (`npm run test:ios`). Use the VM
(`npm run test:ios -- --vm <run>`) before a release whose diff touches `ios/`, the phone listener
or Firma › Handy. The VM variant starts the app with `$V app`, switches the phone on through
`app.mjs` (Firma › Handy), and reads the pairing URL from the card's link instead of
`desktop-host.ts`.

### A1.5 What stays manual on a real iPhone

The simulator has no camera, enforces no Local Network privacy, and has no real Wi-Fi. A checklist
in `docs/releasing.md` «The iPhone app», run **when the release's diff touches `ios/`**, takes
about 10 minutes. The release PR records the result as one table:

1. «Scannen»: a crumpled two-page till receipt. VisionKit auto-crop, perspective and page count
   are right, and the PDF is readable on the Mac.
2. Pairing with the camera: scan the QR code on Firma › Handy (`DataScannerViewController`).
3. The first contact shows the iOS Local Network prompt with the app's text
   (`NSLocalNetworkUsageDescription`). After «Nicht erlauben», the banner names the cause.
4. Over Wi-Fi to the packed Mac app, and over the iPhone's USB hotspot.
5. The pairing survives an app update installed over the old one (Keychain
   `AfterFirstUnlockThisDeviceOnly`).
6. On-device OCR naming on three real photos («vorläufig» and a plausible name).
7. Dark mode and the largest Dynamic Type size on the main list and in Settings.

## A2. Opt-in and excluded by default

### A2.1 Scripts

- `npm test` is unchanged. Its glob `tests/**/*.test.ts` does not match Swift files.
  `tools/ios/` holds no `*.test.ts`.
- `npm run test:ios` runs `sh tools/ios/run.sh`. It refuses with exit code 2 and one line per
  missing piece:
  - «test:ios braucht macOS mit Xcode (xcodebuild fehlt). Die anderen Tests brauchen das nicht:
    npm test.»
  - «Kein iOS-Simulator (xcrun simctl list runtimes zeigt kein iOS 17+): Xcode › Settings ›
    Platforms.»
  - «xcodegen fehlt: brew install xcodegen.»
- `npm run test:ios -- --vm <run>` is the VM variant (A1.4). `--keep` leaves the simulator device
  for a look afterwards. By default the script deletes the device.

### A2.2 CI

A new workflow `.github/workflows/ios.yml` runs on `macos-15`. Its `on.pull_request.paths` and
`on.push.paths` (branch `main`) are:

```
ios/**, src/server/routes/scan.ts, src/server/phone.ts, src/server/scan.html,
src/desktop/server.ts, tools/ios/**, tests/ios/**, .github/workflows/ios.yml
```

It also has `workflow_dispatch`. It runs `npm ci`, `brew install xcodegen`, then
`npm run test:ios`, and uploads the xcresult bundle as an artifact. macOS minutes are free on a
public repository and ten times the Linux price on a private one, which is one more reason for the
paths filter. `src/desktop/server.ts` changes for reasons other than the phone. Splitting the
phone listener into `src/desktop/phone-listener.ts` would let the filter name only that file.
That split is a small refactor in phase A2.

### A2.3 The verify skill

`.claude/skills/verify/SKILL.md` gains a section «The iPhone app in the Simulator». A walk starts
the simulator only when asked: `vm.sh up <run> --ios` boots a simulator paired with that run's
VM, or a persona file names `needs: ios` in its head. `phone-sync.md` gets that line. Its
host-side HTTP simulation stays as the fallback when Xcode is missing. No other persona starts
the simulator.

### A2.4 Other heavy suites, by the same principle

| Suite | Today | Proposal |
|---|---|---|
| Browser tests (11 files use `launchChrome`) | in `npm test` | stay: each takes seconds, and Chrome for Testing is a documented requirement |
| `npm run desktop:e2e` (Tart VM, packed app) | opt-in already | unchanged |
| `npm run eval:pairing` (a workspace's own links) | opt-in, model optional | gains the persona workspaces (A3.5) |
| `npm run test:books` (one's own books) | opt-in, needs a private workspace | unchanged |
| VM persona walks (`vm.sh`) | by hand or by agent | unchanged; `--ios` as above |
| Regenerating persona files (`persona-files.mjs`, needs Google Chrome) | by hand | the fixtures are committed (A3.2), so `npm test` never renders |

**Machine load** (MacBook Air M3, 24 GB). `xcodebuild` takes every core for about two minutes,
and a booted simulator holds 2–3 GB. `tools/ios/run.sh` takes a lock of its own,
`$TMPDIR/vanilla-heavy.lock`. While `tart list` shows two running VMs, it refuses: «Zwei VMs
laufen: test:ios erst danach (Arbeitsspeicher)». `vm.sh up` refuses a second VM while
`test:ios` holds the lock. Running one VM next to the simulator is allowed; the `--vm` variant
needs exactly that. `test:ios` never waits for or takes the `npm test` lock. The two can run
side by side, and `npm test` already runs at nice 10.

## A3. Full-pipeline persona tests (issue #509, level 2)

### A3.1 What a persona test is

Each persona's files go through the **real** intake into a fresh workspace made by the real
setup. The AI is replaced by recorded answers. The result is compared with an answer key. The
test runs in `npm test` and takes seconds per persona.

```
tests/personas.test.ts               one test() per persona under tests/personas/
tests/personas/<name>/
  persona.json     the setup answers: firm, legal form, IBANs, VAT setup, employees (what vm.sh up types)
  files/           the persona's files as persona-files.mjs renders them (committed, made-up)
  drops.json       the order in which the person drops them: [["camt…xml", "…pdf"], ["orders.csv"], …]
  ai.jsonl         recorded AI answers (A3.3)
  key.json         the answer key: truth from the persona's simulation (A3.4)
  golden.json      what today's pipeline produces from these files (A3.4)
  known-gaps.json  where the app differs from the key today, each with its issue number
```

The test copies the files into `$TMPDIR` and creates the workspace with `scaffold` and setup from
`persona.json` (the code path `npm run init` takes). It adds every drop through the drop route's
function (`src/server/routes/drop.ts` → inbox / statements / sales reports), then runs
`runIntake` (`src/intake/pipeline.ts`) and the booking step as the background run does after a
drop. The run uses `CLAUDE_BIN = tests/support/stub-bin/claude` with
`CLAUDE_STUB_REPLAY = tests/personas/<name>/ai.jsonl`. It then reads the books with `loadBooks`.

Personas at start: `consulting` and `webshop`, which have keys in `persona-files/*.mjs` already,
and `huber`, whose builder needs a key added (`persona-files/huber.mjs` has none today). Each new
firm of #509 (freelancer, health practice, restaurant, shop with a till, landlord) adds one
folder.

### A3.2 The files

`persona-files.mjs` gains `--fixtures <name>`. The flag writes `files/`, `persona.json`,
`drops.json` and `key.json` into `tests/personas/<name>/` from the same `build()` the VM walks
use. PDFs rendered by Chrome are not byte-stable, so they are committed and never re-rendered
during a run. Regenerate them only when the persona changes, and review the diff. The files are
made-up and public (`tests/**` is in `public-files.txt`). The leak guard runs on them like on any
other public file.

### A3.3 Recorded AI answers

The stub `tests/support/stub-bin/claude` already tells the prompt kinds apart: classify, VAT
facts, OCR, match, document kind. It gains two modes:

- **Replay** (`CLAUDE_STUB_REPLAY=<file>`). The stub finds the answer by **(kind, subject)**,
  where the subject is the receipt id (sha prefix) or the sorted transaction refs the prompt
  names. It does not use a hash of the whole prompt, so a reworded prompt still finds its answer.
  The line also stores the prompt's hash. When the hash differs, the test passes and logs «prompt
  changed since recording: <kind> <subject>». When no answer exists, the stub exits with code 3
  and the message «no recorded answer for <kind> <subject>: npm run personas:record -- <name>».
  The test then fails and names the command.
- **Record** (`npm run personas:record -- <name> [--only <kind>]`). The stub runs the same
  pipeline with the real `claude` behind it (the person's own subscription; never in `npm test`
  or CI). It writes `ai.jsonl` anew and prints a summary: answers changed, new, gone, and their
  kinds.

### A3.4 Answer key and golden master: two comparisons

- **`golden.json`** is the regression net. It holds what the pipeline produces today, for the
  same purpose as `tests/golden/demo/`: links (receipt file → payment ref), entries
  (`ref, date, debit, credit, vatCode, amount`, sorted), questions asked (kind, subject), the
  Ziffern per filing period (computed as `tests/vat-golden.test.ts` does), and the clearing
  account balances. The comparison is exact, and any difference fails the test.
  `UPDATE_GOLDEN=1 node --import tsx --test tests/personas.test.ts` rewrites the file.
- **`key.json`** is the truth. It is generated from the persona's simulation, the same data that
  writes `answer-key.md` for the VM walks, and allows the alternatives the key already names (for
  example «4xxx M81 or 6xxx I81» for packaging). The test checks every key item against the books.
  An item listed in `known-gaps.json` must still differ. When it starts to match, the test fails
  with «gap <id> closed: remove it from known-gaps.json». A key item that differs and is not
  listed fails the test. The gaps stay visible and never rot.

**Updating and reviewing.**

| What changed | Command | Who reviews |
|---|---|---|
| The persona (files, story) | `node .claude/skills/verify/persona-files.mjs --fixtures <name>`, then `UPDATE_GOLDEN=1` | normal PR review. A Ziffer change in `key.json` is a VAT figure, so it goes to the owner (merge rules). |
| A prompt or the model | `npm run personas:record -- <name>`, then `UPDATE_GOLDEN=1` | the PR names the record summary. A changed answer for a prompt that did not change means the model drifted, and the reviewer says so. |
| App code changed a booking | `UPDATE_GOLDEN=1` | the `golden.json` diff in the PR. A changed Ziffer also gets a CHANGELOG entry marked **⚠ figures**, as for the demos (docs/releasing.md). |
| A gap closed or opened | edit `known-gaps.json` | the PR names the issue |

Time budget: under 10 s per persona on the M3. If a persona goes over, the test logs its time,
and the fix goes into the pipeline or the persona's size, never into a skip.

### A3.5 `eval:pairing` with the real AI, before each release

`tools/eval/pairing.ts` blinds a workspace's own links. For a persona, the links in `key.json`
are the truth. `npm run eval:pairing -- --persona <name>` builds the persona's workspace as A3.1
does, with **the real model** instead of replay. It then takes the key's links as the books'
links and runs the existing blinded comparison. It prints the counts per stage, as today. The
command is opt-in (it uses the person's subscription) and runs before each release on every
persona. Its output (counts only) goes into the release PR. A drop against the last release's
counts blocks the release until it is explained.

## A4. Per persona (issue #509 level 1)

| Persona | Phone (A1) | Pipeline test (A3) | Differs in |
|---|---|---|---|
| Thomas Huber, painter (Swiss German, impatient, on building sites) | yes: photos, poor Wi-Fi, Mac off (`P3`, `P4`), double send | `huber` | till photos, a duplicate PDF, wrong files |
| Marco Rossi, Huber's employee (Italian first language) | yes, in German today (A0.4) | – | the app's language |
| Corinne Wyss, tea webshop | rarely | `webshop` | sales report, clearing account, import VAT |
| Matthias Kälin, consultancy (expert, fast) | his own receipts abroad | `consulting` | EUR, Bezugsteuer, private outlays, the phone's private share |
| The five new firms of #509 | the restaurant's till slips and the shop's day takings by phone | one folder each | per #509 |

## A5. Phases and acceptance checks

| Phase | Work | Accepted when |
|---|---|---|
| A-1 | `BelegeUITests` target, identifiers, `UITestHooks.swift` (DEBUG), `desktop-host.ts`, `run.sh` preflight, phases `P1`, `P2` | `npm run test:ios` passes on the M3 from a clean clone. It refuses with the three messages when the tool is missing. A Release build contains no `-uitest-`. |
| A-2 | `P3`–`P6`, `check.ts` | each phase's Mac-side check fails when the phone part is broken on purpose (no token header; `synced` set before 200) |
| A-3 | `ios.yml`, the phone listener in its own file, the verify skill's `--ios`, the lock | CI runs on a PR touching `ios/` and is skipped on one touching only `src/accounting/` |
| A-4 | the `--vm` variant | `P1`–`P2` pass against the packed app in a VM |
| A-5 | the stub's replay and record modes, `tests/personas.test.ts`, `consulting` and `webshop` | both personas pass in `npm test` in under 10 s each. A deliberately wrong VAT code in the classifier fails both, naming the entry. |
| A-6 | `huber` key and fixtures, `--persona` for `eval:pairing` | three personas; the eval prints the counts per persona |

---

# Part B: the fiduciary loop

## B0. What exists today

- **Who decided a booking** is `JournalEntry.by` (`src/types/index.ts`, `BookedBy`): `rule`,
  `code`, `model`, `person { at, was }` or `assistant { at, conversation, was }`. **It names no
  person.** `was` keeps the booking fields before a person's change. `reason` keeps why, also
  from a person (`src/server/edits.ts` sets it).
- **Who may replace what** is decided by the write door `update(books, actor, fn)`
  (`src/books/store.ts`). The actor is `person`, `module` or `run`. A person's entry
  (`origin: 'manual'`) changes only by a person.
- **Saves are git commits** (`src/workspace/git.ts commitExactly`). Their author is
  `GIT_AUTHOR_*`, then the repository's `user.name`, then `~/.gitconfig`, else «Vanilla
  Accounting». The app's commits carry the trailers `Vanilla-Kind`, `Vanilla-Run` and
  `Vanilla-Person: the app's user` (a placeholder, `src/saving/saving.ts`, `src/saving/rules.ts`).
- **Änderungen** (`src/app/areas/changes/changes.tsx`) shows the history (`history()`, with each
  save's author). The detail shows what changed since the last save: `handEdits` (a person's or
  the AI sidebar's booking changes, with «Rückgängig»), `recordChanges`, `receiptChanges` and
  file diffs.
- **«Ins Wissen übernehmen?»** (`src/saving/learn-rule.ts`, `LearnOffer` in
  `src/app/areas/journal/Detail.tsx`) appears under a person's change of account or code.
  **«Regel anpassen?»** (`src/saving/correction-rule.ts`) appears under a correction of a rule's
  booking.
- **Sync** (`syncState`, «Synchronisieren» in `src/saving/saving.ts`) pulls only when the pull
  fast-forwards, then pushes. When the two lines have diverged, sync refuses. It never rewrites
  history.
- **Seals, `closedThrough`, `corrects`, the 0535**: the golden rules in AGENTS.md.
- **Audit export** (`docs/audit-export.md`, `npm run build:audit`): a static read-only copy.
  Banana TSV export.
- **Planned and not built:** ADR 0003 (roles from the git host or `access.yaml`; branches per
  contributor; a cloud instance for the fiduciary; a record-by-record merge; «since your last
  visit»). `docs/personas/README.md` has the role table «Who can do what».

**The gap:** the app tells a person from the AI, but it does not tell one person from another.
It cannot show «what the fiduciary changed».

## B1. The case and its personas

The owner books everything (with the AI). To keep costs low, he hands the books to a family
member who is a fiduciary. The fiduciary corrects what is wrong, mostly himself, and hands the
books back. The owner wants to **see what was fixed** so that he books better next time.

| Persona | Role | Language, skill, manner | What the loop must give them |
|---|---|---|---|
| **Sandra Huber** (owner's side, Malerei Huber GmbH) | owner | Swiss German; not technical; careful, busy; books with the AI | one button to hand over; afterwards a plain list «Was Ernst geändert hat», grouped, with «so mache ich es nächstes Mal» (a rule) in one click |
| **Ernst Bühler**, Sandra's uncle (new, family fiduciary) | fiduciary | German; 71, retired fiduciary, 30 years with Banana; slow mouse, large text, prefers one screen at a time; no AI, no git; phones rather than writes | opens the books from a file or a shared folder on his own Mac under his name. He corrects with debit and credit and a short «Warum?». He hands back with one button and is never asked a technical question. |
| **Monika Frei** (existing, `treuhaender.md`) | fiduciary | German; professional with 40 clients; fast, keyboard; no AI | the same loop for many clients. «Seit deiner letzten Übergabe» per client. |
| **Luca Bernasconi** (new) | auditor | Italian, from Ticino; reads the UI in Italian; expert | read-only: who changed what (the same review view, read-only), seals, filed returns. Gets the audit export or opens the shared repository as `auditor`. |

## B2. Who is who

**A person per device.** The desktop state (`src/desktop/state.ts`, `desktop.json`) gains
`person: { name, email }`. The app asks once, the first time books are opened on this Mac whose
history shows another author, and again under Firma › Personen:

> **Wer arbeitet an diesem Mac?** Name, E-Mail. «Damit man in den Änderungen sieht, wer was
> gemacht hat.»

`authorOf` (`src/workspace/git.ts`) puts this person after `GIT_AUTHOR_*` and before the git
config: an explicit environment variable still wins for developers. Every app commit's trailer
`Vanilla-Person: the app's user` becomes `Vanilla-Person: <email>`. A terminal agent working for
a person keeps that person as author and adds `Vanilla-Via: ai` (ADR 0003 §4).

**Roles in the workspace.** A new file `access.yaml` at the top of the workspace (in `LAYOUT.top`
as `company`; ADR 0003 names it). Only the owner edits it, under Firma › Personen:

```yaml
schema: 1
people:
  - { email: sandra@malerei-huber.example, name: Sandra Huber, role: owner }
  - { email: ernst@buehler.example, name: Ernst Bühler, role: fiduciary }
  - { email: luca@revisione.example, name: Luca Bernasconi, role: auditor }
```

| Role | May (from `docs/personas/README.md`) | Refused locally (403, code `roleRefused`, words in the UI) |
|---|---|---|
| owner | everything | – |
| fiduciary | book, correct, link, year-end entries, rules and knowledge, «Quartal geprüft», hand back | file a return, seal, close the year, company settings, `access.yaml` |
| auditor | read everything, export | every write: the app opens read-only (the `READONLY` mode of `src/server/api.ts`) |

A person missing from `access.yaml` is the owner when the file is absent, which is every
workspace today. When the file exists, a missing person becomes `fiduciary`, and the app shows
«Nicht in Firma › Personen: arbeitet als Treuhänder». These are **guards against mistakes, not
security**, as ADR 0003 §1 says. Whoever holds the folder can edit it. The seals and `main` on
the git host stay the real boundary.

## B3. The hand-over

The books change hands as a **baton**: one side works at a time. This fits sync as it is
(fast-forward only), and the record-by-record merge (ADR 0003 §3) stays unneeded for this case.

**Two ways, same marks:**

1. **Gemeinsamer Ordner / Repository**: the workspace has a git remote (GitHub, or a shared
   folder with a bare repository). Each side syncs with «Synchronisieren». For people with a
   remote.
2. **Als Datei** (the default for Ernst): a `.vanilla` file that carries **only what the other
   side lacks**. The format is B3.1.

### B3.1 The `.vanilla` file: incremental

Receipts are about 95 % of a workspace's size: about 250 MB per year of receipts, 864 files in
one real year, so about 290 KB each. A zip of the whole repository would grow by that much every
year and would soon take gigabytes to send. The file therefore never carries the whole history.

**What is in the file.** A `.vanilla` file is a zip with two members:

- `manifest.json`: `kind` (`full`, `update` or `return`), the company's name and UID (to refuse a
  file of another company), `base` (the mark commit the bundle builds on; absent for `full`),
  `mark` (the commit it brings), the app version, the SHA-256 of `bundle`, and for `full` the list
  `omitted` (B3.2).
- `bundle`: a git bundle (v2: a header naming the prerequisite commit and the refs, then one
  packfile). The app writes and reads it with isomorphic-git (`packObjects` for the pack,
  `indexPack` on arrival) and writes the bundle header itself. It needs no git program: a Mac
  without the developer tools has none, and running the `/usr/bin/git` stub opens Apple's install
  dialog (`src/platform/git-program.ts`).

**Three kinds:**

| Kind | Made by | Carries | Typical size |
|---|---|---|---|
| `full`, the first hand-over to this person | «Übergeben» when no earlier mark was returned by this recipient, or when the owner picks «Vollständig» | the `given` mark commit as a shallow root (no parents), all tree objects, and every blob except the closed years' receipts and statements (B3.2) | about 60 MB in April (Q1's receipts and statements); up to about 250 MB at year end; up to about 300 MB in the first months of a year, while the previous year is still open (B3.3) |
| `update`, every later hand-over | «Übergeben» when the recipient's last return proves he holds a mark | the commits from that mark to the new `given` mark: the quarter's new receipts, statements and bookings | tens of MB (one quarter is about 60 MB of receipts) |
| `return` | «Zurückgeben» on the recipient's Mac | his commits from the `given` mark to his `returned` mark | kilobytes for bookings, plus any receipt he adds |

The owner's app keeps, per recipient, the newest mark that recipient returned. A `return` built on
mark M proves the recipient holds M, so the next `update` uses M as its base. The owner never has
to guess what the other Mac holds.

### B3.2 Closed years stay out, and stay provable

A `full` file leaves out the blobs under `transactional-data/<year>/receipts/` and
`…/bank-statements/` of every year the books have closed (`closedThrough` at 31.12. of that year
or later). Everything else of those years comes along: their books (`books/*.jsonl`), filings and
seals, which are small. The seals and `loadBooks` therefore work on the copy, and corrections that
reach back (`corrects`) can still be checked.

`omitted` lists each left-out file as `{ path, blob, sha256, bytes }`. The trees in the bundle
name the same blob ids, so the recipient's app proves two things:

- **Nothing is missing for what it shows.** Every receipt that an entry of an open period links
  is present. A link to a closed-year receipt shows «Im Archiv bei Sandra Huber (Prüfsumme …)»
  instead of the PDF.
- **Integrity.** Each omitted file is in the list, and the list's hashes match the trees. The
  owner, or an auditor holding the full repository, can check any archived file against them.

**The recipient never loses a closed year by committing.** His copy is a sparse checkout of the
open paths. When he saves, the app builds the new commit's tree from the base tree and replaces
only the subtrees he changed. It never writes the tree from the index alone, because the index
lacks the omitted paths and git would read their absence as a deletion. A save whose tree drops a
path of `omitted` is refused (a test proves it).

### B3.3 Year boundaries

- **A new year starts small.** As soon as the owner closes a year, its receipts and statements
  drop out of the next `full` file. A first hand-over in a new year carries at most the one or
  two open years.
- **The owner closes the previous year after Q4 is filed, often months later.** Until then, two
  years are open, and a `full` file carries both, up to about 300 MB in, say, March.
- **A hand-over that spans the year boundary** (given in December, returned in February) needs
  nothing special. The `return` holds his entries in both years, and `Vanilla-Window` names both.
  The owner cannot close the year meanwhile, because the hold (below) refuses that write too. She
  closes it after the return, and the closed year then leaves the next `full` file.
- **A year closed after the recipient got it** stays in his copy as it was. A later `update`
  carries only new commits and removes nothing. «Platz freigeben» on his side may drop closed
  years' receipts from his copy, keeping them in `omitted`. That is optional and never automatic.

### B3.4 In the app

- **«Übergeben»** (Firma › Personen, and in Änderungen) asks only to whom and where to save the
  file. The app picks `full` or `update` itself and says which: «Nur die Änderungen seit der
  Übergabe vom 13.08. (48 MB)», or «Vollständige Übergabe: 2026 (212 MB), abgeschlossene Jahre
  bleiben bei dir». «Vollständig» is a choice under «Mehr».
- **«Übergabe öffnen»** applies any `.vanilla` file. A double click on one opens the Mac app
  (`fileAssociations` in `desktop/electron-builder.config.cjs`, the `open-file` event). The app
  reads `kind`:
  - `full`: it creates the copy in its own folder
    (`~/Library/Application Support/Vanilla Accounting/Treuhand/<UID>/`) and lists the copy under
    the recent books by the company's name. The fiduciary never sees the folder or git.
  - `update`: it checks that the copy holds `base`, indexes the pack, moves the branch
    forward to `mark` and checks out the open paths.
  - `return` (on the owner's Mac): it checks that `base` is her `given` mark and that her HEAD is
    still that mark, then fast-forwards. Nothing of hers is replaced.
- **A missing base** (a lost copy, a new computer, a file opened twice out of order) is refused
  without changing anything. On the recipient's Mac the refusal says: «Diese Übergabe baut auf
  der vom 13.08. auf, die auf diesem Mac fehlt. Bitte Sandra Huber um eine vollständige
  Übergabe.» On the owner's Mac, a `return` whose base is not her current `given` mark is a
  diverged return, and it opens as a review only (as after «Zurücknehmen»).
- **«Zurückgeben»** saves what is unsaved and writes the `return` file. It suggests saving the file
  next to the one he opened and names its size.
- **Files of another company** (the UID differs) and files whose `bundle` hash does not match are
  refused, naming the reason.

**The marks** are empty commits on the branch with trailers. Sync carries them like any other
commit, which it would not do for tags. The bundle's base is always such a mark:

```
Übergeben an Ernst Bühler

Vanilla-Kind: handover
Vanilla-Handover: given
Vanilla-Person: sandra@malerei-huber.example
Vanilla-To: ernst@buehler.example
Vanilla-Window: 2026-07-01..2026-12-31
```

The return mark has `Vanilla-Handover: returned`, written by Ernst's «Zurückgeben». Before it
writes the mark, «Zurückgeben» saves everything still unsaved under his name, one save per kind,
so that nothing is lost and he never sees «Speichern vorbereiten».

**While the books are away** (between `given` and `returned`, on Sandra's Mac):

- The write door refuses a person's and a module's book writes with code `handedOver`: «Die
  Bücher sind seit 13.11. bei Ernst Bühler. Zurück, sobald er sie zurückgibt.» This is a fact,
  not a reminder.
- The phone, mail and drops still deliver into the inbox (`beleg-import/`). The background
  intake that books them waits and runs after the return.
- «Übergabe zurücknehmen» is there for a fiduciary who never answers. It writes
  `Vanilla-Handover: withdrawn`. If his file comes back after that, it opens as a review only
  (B5): his changes can be applied one by one, but are never merged as a whole.

## B4. The fiduciary works under his name

- On Ernst's Mac, the identity of B2 makes him the author of every save, whatever book he opens.
- The top bar shows a fact: «Malerei Huber GmbH · von Sandra übergeben am 13.11.».
- In the entry editor, `reason` becomes a visible field **«Warum? (für Sandra)»**, optional, one
  line, next to «Speichern». `edits.ts` keeps it as it does today.
- **A filed quarter stays as filed.** In a closed period, Ernst's change is refused as today
  (403, `assertOpen`). The entry's detail then offers «Korrektur im offenen Quartal buchen». The
  correction carries `corrects: "2026-Q2"`, and its description names the original id (the
  golden rule; `src/accounting/correction.ts correctsFor`). The MWST tab shows its effect on the
  Q2 0535.
- He works without the AI. Every step he takes is a hand step the app has already (MISSION:
  possible without the AI). Simple screens for him mean: no new mode, but the review and the
  editor keep to one column at 1280 px and follow the system's text size.

## B5. The review view «Was Ernst geändert hat»

**Where:** Änderungen. The return mark is a row in Verlauf («Zurück von Ernst Bühler · 14
Änderungen»). Its detail is the review. The route is `/changes/<commit>` as today, with a
`review` detail for a `returned` mark. Nothing new goes in the dock.

**What:** the records' difference between the `given` and the `returned` mark. It is computed by
a new `handoverReview(ws, given, returned)` in `src/saving/handover.ts`, which applies the logic
of `recordChanges`/`receiptChanges` to two commits instead of HEAD and the worktree. It covers
the journal entries, mappings, receipts and transactions of every year in the window, and the
customizing files (`knowledge/`, `master-data/accounts.json`).

**Per corrected entry:** the date, the description, **before → after** for the changed fields
(debit, credit, code, amount, date), his «Warum?», **who made the booking he changed**
(Sandra by hand, rule `swisscom-telefon`, the AI with its reason), a link to the receipt and the
payment (`hrefOf` with a period holding the date), and for a correction of a filed quarter
`corrects` plus the change in that quarter's 0535 (bisher / korrigiert / Differenz).

**Grouped by the kind of correction,** each group with its count, in this order:

1. Korrekturen eingereichter Quartale (`corrects` set)
2. MWST-Code geändert
3. Konto geändert
4. Betrag oder Datum geändert
5. Aufgeteilt (one booking became several lines, or a private share was added)
6. Beleg zugeordnet, gelöst oder ersetzt
7. Neu gebucht (depreciation, accruals and other entries without a payment)
8. Gelöscht
9. Regeln, Konten und Wissen geändert (file diffs, as Änderungen shows them today)

Within each group, entries come by partner. «4 Zahlungen an Swisscom: 6500 → 6510» is one row
that opens into its four entries.

**Afterwards.** The review stays reachable as long as the history holds the marks. Ernst sees the
same view on his Mac («Was ich geändert habe»), and Luca sees it read-only.

## B6. Learning from each correction

Each row of the review offers one way to learn from it. Code chooses which way; nothing is kept
until Sandra keeps it:

| What he corrected | Offered | Path |
|---|---|---|
| A booking a rule made | «Regel anpassen?» | `src/saving/correction-rule.ts` → the rule card |
| Account or code, on a partner he corrected two or more times the same way | «Immer so buchen?» | `src/saving/learn-rule.ts` (its threshold `GENERAL` counts the corrected payments; his corrections satisfy it together) → the rule card with preview and «Trotzdem behalten» |
| A one-off with a «Warum?» | «Als Notiz zu <Partner> merken» | the partner's notes (`src/saving/note-rule.ts` decides whether the sentence becomes a rule) |
| A private share added | «Immer so?» | `src/saving/share-rule.ts` |
| A new entry kind without a payment (depreciation, accrual) | nothing to learn per entry; listed for the year close | – |
| Amount or date only | nothing: a fix, not a practice (as learn-rule.ts says) | – |

A row whose offer Sandra kept or dismissed shows «übernommen» or «nicht übernommen» as a fact.
Nothing counts down, and nothing comes back.

## B7. Invariants this loop must keep

- **A filed quarter never changes.** The review never offers «Rückgängig» on a closed entry.
  Ernst's corrections of filed quarters are correction entries with `corrects` (B4). A return
  whose commits change a sealed record cannot be opened: `loadBooks` already loads such books
  read-only (`SealBrokenError` on save). «Übergabe öffnen» refuses before it moves the branch and
  names the record.
- **A person's change is never overwritten by the AI or a rule.** Ernst's entries are
  `origin: 'manual'`, `by.kind: 'person'`. After the return, the waiting intake and every
  classify run are module actors, and the write door refuses them on those entries. A test
  proves it (B11).
- **Sandra can undo any of his changes** in an open period. The undo is a new change under her
  name (ADR 0003 §4); his change stays in the history.

## B8. Notifications, without nagging

The memory rule applies: state facts, never remind of chores.

- On Sandra's Mac after «Übergabe öffnen»: the Verlauf row «Zurück von Ernst Bühler am 20.11. ·
  14 Änderungen». No badge, no count of «unread», no «bitte prüfen».
- While the books are away: the `handedOver` fact in the top bar and on refusals (B3).
- On Ernst's Mac: «von Sandra übergeben am 13.11.». No «noch nicht zurückgegeben» after n days.

## B9. Data model: what changes, and the schema flags for the owner

| Addition | Where | Schema step? |
|---|---|---|
| `person { name, email }` | `desktop.json` (per device, not in the books) | no |
| `access.yaml` with `schema: 1` | workspace top, `LAYOUT.top` (`company`), listed by `npm run doctor` | **a new file with its own version**. No step of `belege.workspace.yaml` (`WORKSPACE_SCHEMA` 4) or of the books (`BOOKS_SCHEMA` 9). The alternative, `people:` inside `belege.workspace.yaml`, would be `WORKSPACE_SCHEMA` 5 with a ladder step. **Owner decides** (Q-B1). |
| hand-over marks | empty commits with trailers | no |
| the `.vanilla` file (`manifest.json` with its own `format: 1`, plus a git bundle) | a file outside the workspace | no: the file is versioned on its own. The books inside are unchanged. |
| per recipient, the newest mark returned | the owner's desktop state | no |
| the recipient's copy: shallow root and sparse checkout, `omitted` kept beside it | `.git/shallow` and the app's folder on the recipient's Mac | no: git's own shallow format. The workspace format is unchanged. |
| `Vanilla-Person: <email>` trailer | commit messages | no |
| who changed an entry | **derived from git**: the review attributes each changed record to the author of the commits between the marks | no |
| `by.who` (the person's email on `by.kind: 'person'`) | `JournalEntry.by` | **yes: `BOOKS_SCHEMA` 10 with a ladder step.** Seals hash `by`, and `src/types/index.ts` says a new field there is a format change. Old entries keep their `by` (absent = unknown). Needed only if attribution must survive without git history (an audit export without the repository, a squashed history). **Owner decides** (Q-B2). Not in phases B-1 to B-4. |

## B10. UI placement and i18n

- **Änderungen:** the Verlauf rows for marks, the review detail (B5), «Übergabe öffnen».
- **Firma › Personen** (a new section of the company area, `src/app/areas/company/`): this
  Mac's person, `access.yaml`'s people and roles, «Bücher übergeben …», «Übergabe
  zurücknehmen».
- **The top bar:** the hand-over fact.
- **The entry editor** (`src/app/areas/journal/`): the field «Warum? (für …)».
- **Texts:** new keys under `handover.*`, `people.*` and `review.*` in
  `src/app/i18n/locales/de.ts`, with `fr`, `it` and `en` matching (`tests/i18n.test.ts`). The
  refusals `handedOver` and `roleRefused` go into `src/types/api-error.ts`. Luca reads the review
  in Italian, so `it` must cover the review fully, not as a fallback.
- **CSS:** `src/app/areas/changes/changes.css` with the existing tokens. No new colour without a
  token.

## B11. Tests

**Unit and integration** (`npm test`):

- `tests/handover-review.test.ts`: a temp repository. Sandra books (author A), and «given» is
  written. Ernst changes an account, a code and an amount, splits one booking, links a receipt,
  books a depreciation, deletes one entry, and corrects Q2 with `corrects` (author B), then
  «returned». `handoverReview` returns each change in its group with before/after, author B,
  his reason, and who made the original. It returns nothing for commits outside the marks.
- `tests/handover-file.test.ts` runs on a temp workspace with a closed 2025 and an open 2026, and
  small made-up receipts:
  - `full` leaves out 2025's receipts and statements, and `omitted` lists them with hashes that
    match the trees. The seals verify on the copy.
  - Ernst changes something and returns. Sandra's «Übergabe öffnen» fast-forwards, and the
    `return` holds only his commits (size of the order of his objects).
  - A second «Übergeben» is an `update` on the returned mark and carries only the new receipts.
  - Applied on a copy without its base, the `update` is refused (`handoverBaseMissing`) and
    nothing changes.
  - A save on the sparse copy keeps every omitted path in the tree.
  - A hand-over spanning 31.12. returns entries of both years.
  - Refused: Sandra booked meanwhile (diverged), the return changes a sealed record, another
    company's UID, a bundle hash mismatch.
  - No git program is spawned (`gitProgram` stubbed to throw).
- `tests/handover-hold.test.ts`: while handed over, a person's and a module's book writes get 403
  `handedOver`, and an upload still reaches the inbox. After the return, the intake runs and does
  not touch Ernst's `origin: 'manual'` entries. «Zurücknehmen» lifts the hold.
- `tests/identity-author.test.ts`: the desktop person becomes the commit author and the
  `Vanilla-Person` trailer. `GIT_AUTHOR_NAME` still wins.
- `tests/access-roles.test.ts`: auditor writes are refused, fiduciary filing and sealing are
  refused (`roleRefused`), a missing `access.yaml` means owner, and a person missing from the
  file works as a fiduciary.
- A row per new write route in `tests/period-lock.test.ts`.
- One browser test (`launchChrome`): the review renders its groups and a learn offer opens the
  rule card.

**Persona walk.** `.claude/skills/verify/personas/treuhaender.md` gains the scenario «Ernst,
family fiduciary» on two VMs, Apple's limit, so the simulator stays off (A2.4):

1. VM `sandra` from snapshot `huber-q3`: she books Q3 with the AI, with three planted mistakes
   (an account, a VAT code on a receipt without Swiss VAT, a private lunch), then «Bücher übergeben
   …» as a file.
2. The host copies the file into VM `ernst` (fresh, no Claude). He opens it, tells the app who he
   is, and corrects by hand under his name: «Warum?» on two corrections, one correction of the
   filed Q2. Then «Zurückgeben».
3. Back in `sandra`: «Übergabe öffnen». Judge: does she understand the review without help? Does
   she keep a rule from it? Does the next intake keep Ernst's changes? Is anything nagging?

Judge Ernst as written in B1: large text, one screen at a time, no technical question, debit and
credit by keyboard. Monika Frei's existing scenario gets one step: «Seit deiner letzten
Übergabe». Luca opens the audit export in Italian and finds Ernst's changes with author and
reason.

## B12. Phases and acceptance checks

| Phase | Work | Accepted when |
|---|---|---|
| B-1 Identity | `person` in desktop state, the question, `authorOf`, the trailer, names in Verlauf | in a fresh VM, two Macs saving the same repository show two names in Verlauf |
| B-2 Hand-over by file | the `.vanilla` format (`full`, `update`, `return`; B3.1–B3.4), marks, the hold, «Übergeben», «Übergabe öffnen» by double click, «Zurückgeben», «Zurücknehmen» | `handover-file` and `handover-hold` pass; the walk's steps 1–2 work without a terminal and without a folder dialog; on books with a closed year of real size, the `full` file is no bigger than the open years' receipts plus their books, an `update` is no bigger than the quarter's new objects, and a `return` of bookings only stays under 1 MB |
| B-3 Review | `handoverReview`, the review detail, «Warum?» in the editor, i18n de/fr/it/en | `handover-review` passes; Sandra (walk step 3) names what Ernst changed and why, from the screen alone |
| B-4 Learning | the offers of B6 in the review | from the walk, at least one kept rule books the next quarter's matching payment as Ernst did |
| B-5 Roles and the shared repository | `access.yaml`, Firma › Personen, `roleRefused`, the hand-over over a remote | `access-roles` passes; the walk repeated with a shared repository instead of a file |
| B-6 (only if the owner says yes) | `by.who`, `BOOKS_SCHEMA` 10, ladder step | `npm test` and `test:books` green; sealed quarters intact after `npm run update` |

---

## Open questions for the owner

**Part A**

1. **Should the phone send by itself when the Mac comes back** (A0.1)? The screen promises it
   today. *Recommendation:* yes. Re-ping on `scenePhase == .active` and every 30 s while
   something waits, then send. Phase `P4` is written for that and fails until then.
2. **Bonjour discovery of the Mac** (A0.2)? *Recommendation:* yes, in the same change. The paired
   Mac is found again when its address changes, and the token stays the identity.
3. **Localising the phone app** (A0.4)? *Recommendation:* yes, with String Catalogs (de, fr, it,
   en) before the App Store release. It is out of this spec's test scope.
4. **CI on GitHub's macOS runners** for `test:ios`, given that no test CI exists today?
   *Recommendation:* yes, with the paths filter; it costs nothing on a public repository. Running
   `npm test` in CI too is a separate decision.
5. **Commit persona fixtures (PDFs, about 1–3 MB per persona)?** *Recommendation:* yes. Rendering
   in `npm test` would need Chrome and would not be byte-stable.

**Part B**

6. **Q-B1: `access.yaml` as its own file, or `people:` in `belege.workspace.yaml`
   (`WORKSPACE_SCHEMA` 5)?** *Recommendation:* its own file. ADR 0003 names it, it has its own
   version, and the manifest gets no ladder step.
7. **Q-B2: put the person into the books (`by.who`, `BOOKS_SCHEMA` 10)?** *Recommendation:* not
   now. Git history attributes every change between the marks. Revisit when an auditor must see
   authors in an export made without the repository.
8. **Hold the owner's books while they are handed over?** *Recommendation:* yes, with the inbox
   still filling. Without the hold, two people booking at once diverge, sync refuses, and the
   record merge of ADR 0003 §3 would be needed. That merge is much larger than this loop.
9. **The incremental `.vanilla` file (B3.1) as the default hand-over for a fiduciary without a
   git host?** The first hand-over carries only the open years without their closed years'
   receipts (about 60–300 MB). Later ones carry only the commits since the last returned mark
   (tens of MB), and a return carries only his commits (KBs). *Recommendation:* yes. It needs no
   account and no git program, its size follows the quarter instead of the books' age, and the
   base check plus the fast-forward make it safe. Sub-question: should a closed year's receipts
   ever go along in a `full` file, for a fiduciary who checks an old year?
   *Recommendation:* only as an explicit «mit Archiv 2025» under «Mehr», never by default. A
   shared repository comes second (B-5). The cloud instance of ADR 0003 §5 stays for fiduciaries
   with many clients.
10. **May a fiduciary mark a quarter «geprüft», and does that block anything?**
    *Recommendation:* he may mark it, as the role table says. It blocks nothing and shows as a
    fact on the MWST tab. Filing stays with the owner.
11. **Does the review count as the owner's take-over** (ADR 0003 «Arbeit übernehmen»), or does
    he take over row by row? *Recommendation:* the fast-forward is the take-over. Every row can
    be undone afterwards, as a new change. Approving row by row is the proposal step that ADR
    0003 rejects.
