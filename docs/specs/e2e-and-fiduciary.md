# Spec: end-to-end tests for the phone and pairing, and the fiduciary loop

Status: draft for the owner, 2026-11-13; Part B revised with the owner's decisions of
2026-11-14 (sharing by link, the browser view, no hold, take-over per group, the content version). No code yet.
Judged by [MISSION.md](../../MISSION.md),
[ADR 0015](../adr/0015-base-cases-in-the-app-long-tail-in-the-workspace.md),
[ADR 0003](../adr/0003-deployment-and-collaboration.md) (local-first books in git, roles, hand-over,
history) and [ADR 0016](../adr/0016-sharing-books-end-to-end.md) (sharing through a host that
cannot read the books). Level 2 of issue #509 (personas through the real pipeline) is part A3.

The owner asked for two things on 2026-11-13:

- **A.** End-to-end tests for the phone and for pairing. Opt-in, so that a contributor who runs
  `npm test` never needs Xcode or the simulator.
- **B.** The fiduciary loop. The owner books everything and shares the books with an external
  fiduciary, who corrects what is wrong. The owner then sees what the fiduciary fixed, takes it
  over and learns from it.

Each part starts with what exists today, then the proposal, then a phased plan with acceptance
checks. What the owner decided on 2026-11-14 is listed before the open questions at the end; the
open questions each carry a recommendation.

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

The owner decided the shape of this loop on 2026-11-14 (B3 to B6, and the content version in B7).
The clickable prototype is PR #530 (`docs/0.4.0/mockups/share/`, with `notes.html`). The share
service is built in a separate private repository (`vanilla-share`, a Cloudflare Worker with R2
storage). Its wire protocol is that repository's `docs/protocol.md`. This spec names only what the
app needs from it.

`<domain>` below stands for the publisher's web domain, which README.md names. check-public keeps
the company's name and domain out of every other public file (`IDENTITY_FILES` in
`src/publish/leak-guard.ts`), so this spec writes `<id>.share.<domain>`,
`confirm@share.<domain>` and `<domain>/app`.

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
- **The read-only mode** (`READONLY` in `src/server/api.ts`, the audit export of
  `docs/audit-export.md`, `npm run build:audit`) shows «Prüfmodus · nur Lesen». Banana TSV export.
- **Planned and not built:** ADR 0003 (roles from the git host or `access.yaml`; branches per
  contributor; a cloud instance for the fiduciary; a record-by-record merge; «since your last
  visit»). `docs/personas/README.md` has the role table «Who can do what».

**The gap:** the app tells a person from the AI, but it does not tell one person from another.
It cannot show «what the fiduciary changed», and it has no way to get the books to him and back.

## B1. The case and its personas

The owner books everything (with the AI). To keep costs low, he shares the books with a family
member who is a fiduciary. The fiduciary corrects what is wrong, mostly himself, and sends his
changes back. The owner sees **what was fixed**, takes it over, and books better next time.

| Persona | Role | Language, skill, manner | What the loop must give them |
|---|---|---|---|
| **Sandra Huber** (owner's side, Malerei Huber GmbH) | owner | Swiss German; not technical; careful, busy; books with the AI | one dialog to share; she keeps booking meanwhile; afterwards «Ernst Bühler hat 14 Änderungen geschickt», grouped, taken over in a few clicks, with «Immer so?» for a rule |
| **Ernst Bühler**, Sandra's uncle (new, family fiduciary) | fiduciary | German; 71, retired fiduciary, 30 years with Banana; slow mouse, large text, prefers one screen at a time; no AI, no git; phones rather than writes | an e-mail with a link; one page that shows the books in the browser, or installs the app
and opens them; he corrects with debit and credit and a short «Warum?»; one button sends his changes back. Never a technical question, never an account. |
| **Monika Frei** (existing, `treuhaender.md`) | fiduciary | German; professional with 40 clients; fast, keyboard; no AI | the same loop for many clients. Each later share carries only what is new. |
| **Luca Bernasconi** (new) | auditor | Italian, from Ticino; reads the UI in Italian; expert | read-only: who changed what, seals, filed returns. Gets the audit export or a read-only share. |

## B2. Who is who

**A person per device.** The desktop state (`src/desktop/state.ts`, `desktop.json`) gains
`person: { name, email }`. The app asks once: the first time this Mac shares, opens a share, or
opens books whose history shows another author. Firma › Personen changes it later:

> **Wer arbeitet an diesem Mac?** Name, E-Mail. «Damit man in den Änderungen sieht, wer was
> gemacht hat.»

The «Teilen» dialog needs this e-mail: it is the address the invitation is sent from and the one
the sender confirms to the service (B3.3).

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
| fiduciary | book, correct, link, year-end entries, rules and knowledge, «Quartal geprüft», send back | file a return, seal, close the year, company settings, `access.yaml`, share onward |
| auditor | read everything, export | every write: the app opens read-only (the `READONLY` mode) |

**A shared copy carries its recipient's role.** The package names the recipient and the role the
sharer picked (fiduciary by default, auditor for a read-only share). The recipient's app opens
the copy in that role whatever `access.yaml` says. Without a share, a person missing from
`access.yaml` is the owner when the file is absent, which is every workspace today. When the file
exists, a missing person becomes `fiduciary`, and the app shows «Nicht in Firma › Personen:
arbeitet als Treuhänder». These are **guards against mistakes, not security**, as ADR 0003 §1
says. Whoever holds the folder can edit it. The seals stay the real boundary, and every change
that comes back passes the sharer's review (B6).

## B3. Sharing by link

The books reach the fiduciary as **a link in an e-mail, not a file sent around** (owner decision
1, ADR 0016). The sharer's app sends that e-mail from her own mail account; the service stores
only ciphertext and never sees the key. The `.vanilla` file stays as the offline way (B3.7), with
the same format.

**UI wording is neutral.** No text of the app, the page or the invitation uses a family word. It
names the other person by name («Ernst Bühler hat 14 Änderungen geschickt», «An Sandra Huber
zurücksenden») and, where no name is known, by the neutral role («Treuhänder», «Empfänger»). The
prototype's «Papa» (PR #530) is a persona's word and goes into no UI text.

### B3.1 «Teilen…» in the app

A chip «Teilen» in the top bar next to Export, in every area (⇧S). Its dialog asks for:

- **An wen:** the recipient's name and e-mail, proposed from Firma › Personen or earlier shares.
- **Nachricht (freiwillig):** one short text. It goes into the invitation, which the sharer's own
  mail account sends.
- **Was:** decided by the app and named with its size:
  - «Die Buchhaltung, Stand jetzt (64 MB)»: the first share with this person (`full`, B3.4).
  - «Neu seit der letzten Übergabe am 16.11. (12 MB)»: every later share (`update`): 9 bookings,
    14 receipts, the November statement. «Vollständig» stays a choice under «Mehr».
- The fact line: «Ende-zu-Ende verschlüsselt: nur Ernst Bühler kann den Inhalt lesen, der Server
  nicht. Der Link gilt bis 5 Stunden nach dem ersten Öffnen, höchstens 10 Tage. Ernst Bühler
  bekommt eine E-Mail von dir, mit einem Link, ohne Konto, ohne PIN.»

«Senden» encrypts, uploads, and sends the invitation from the sharer's mail account (B3.3). The
chip then reads «Bei Ernst Bühler», and its card shows the share's state as facts: «Gesendet
14.11. 16:42 · 64 MB», «Verfügbar bis 24.11.» (after the first opening: «Verfügbar bis 15.11.
00:04»), «Noch nicht geöffnet» or «Geöffnet am 15.11. 19:04», «Ende-zu-Ende verschlüsselt», and
the buttons «Zurückziehen» and «Neu teilen». The card says: «Du buchst weiter wie immer. Was Ernst
Bühler ändert, kommt als Vorschlag zurück; du entscheidest.»

Sharing writes a content version (B7): the card, the invitation and the page say «Version 12».

### B3.2 Encryption and the service

- **End to end.** The app makes a random 256-bit key per share. Every file of the package is
  encrypted on its own with AES-GCM (a key per file derived from the share key and the file's id,
  large files in chunks with the chunk's index and the final flag in the associated data, so a
  chunk cut, swapped or dropped fails the tag). An **encrypted index** lists the files (B3.4). The
  service stores only ciphertext under random object ids, so it sees neither paths nor names.
- **The link** is `https://<id>.share.<domain>/#<key>`. The key is in the fragment after `#`,
  which a browser never sends to a server. Every share has **its own origin** (`<id>` as a
  subdomain): the page's script holds the key, and another share's page can then read neither its
  storage nor its service worker.
- **The service never receives the key** and sends no e-mail containing it: the invitation goes
  out from the sharer's own account (B3.3). The service has no e-mail provider in v1.
- **What the service does see:** the sharer's confirmed e-mail address (B3.3), the size and number
  of objects, and the times of upload, opening and withdrawal. Never a recipient's address, a
  name, a message, a booking, a receipt or a figure.
- **No PIN, no login, no accounts.** Whoever has the e-mail can open the books. The protections:
  - **5 hours after the first opening** the service deletes the ciphertext, **at the latest after
    10 days** if nobody opens it.
  - **At most 3 openings**, all within those 5 hours. An opening is a fetch of the index; the
    receipts a browser view loads lazily afterwards do not count.
  - **«Geöffnet am …»**: the sharer sees each opening (time only).
  - **«Zurückziehen»** deletes the ciphertext at once; the link then shows «zurückgezogen». It
    **cannot take back a copy already opened**: the card says so («Hat Ernst Bühler sie schon
    geöffnet, bleibt seine Kopie auf seinem Mac»). The app never claims more.
- **Free, within Cloudflare's free tier, with hard caps:** **1 GB per share, 10 shares per sender
  address per day, 5 GB stored in total.** Beyond a cap the service refuses with a reason the app
  shows as a fact, and the dialog offers the `.vanilla` file (B3.7). The free tier's own limits (R2
  storage and operations, Worker requests) stay above these caps.
- **The app's side of the protocol** is a small client (`src/share/client.ts`): confirm the
  sender, create a share, upload objects, read the state (opened, returned), withdraw, fetch a
  return. It talks only to the share service and is tested against a fake service in the test
  process (B12). The protocol itself is `docs/protocol.md` of `vanilla-share`.

### B3.3 The invitation from the sharer's account, and the sender's confirmation

- **The invitation** is an HTML and plain-text e-mail from a template that `vanilla-share`
  provides (the app bundles a copy and fills it in): «Sandra Huber hat dir die Buchhaltung Malerei
  Huber GmbH geteilt · Version 12», the message, one button «Öffnen» with the link, «Gilt bis 5
  Stunden nach dem ersten Öffnen, höchstens bis 24.11.2026». It comes from the sharer's own
  address, so Ernst's «Antworten» reaches her without a Reply-To trick.
- **How the app sends it:** through the mail account the app already uses for receipt import. On
  that account's channel (ADR 0014): over SMTP with the account's stored secret, or through Mail on
  this Mac (the mail program channel), which puts it into the account's «Gesendet» like any mail.
  A workspace without a sending account gets «Link kopieren» and «Im Mailprogramm öffnen»
  (`mailto:` with subject and text), and the sharer sends it herself. The key then still never
  passes the service.
- **The sender confirms her address once, by sending one e-mail.** The simplest proof that needs no
  outgoing e-mail at the service: the app sends, from the same account, a short e-mail with a
  one-time token to `confirm@share.<domain>`. Cloudflare Email Routing hands it to the Worker,
  which accepts it only when the From domain passes DKIM (or SPF) alignment, and from then on
  accepts uploads for that address from this app installation (a device token). It guards the
  upload API against use as free anonymous storage; it is once per Mac and address and needs no
  typing. A provider whose mail fails alignment is refused with that reason, and the dialog offers
  the `.vanilla` file. Without a sending account, «Im Mailprogramm öffnen» does the same with a
  prepared confirmation e-mail.
- **The return** needs no e-mail. The recipient's app encrypts his change set under a new key,
  stores that key wrapped under the share's key, and uploads both to the same share (the package
  carries a return token for that share, so he needs no confirmation of his own). The sharer's app
  sees it on the share card («Ernst Bühler hat 14 Änderungen geschickt») and fetches it: it holds
  the share's key. A return lives under the same rules (5 hours after it is fetched, 10 days at
  most).

### B3.4 The package: incremental, file by file

Receipts are about 95 % of a workspace's size: about 250 MB per year of receipts, 864 files in one
real year, so about 290 KB each. A package of the whole repository would grow by that much every
year. The package therefore never carries the whole history, and it is built so that a browser
can show it file by file.

**What is in it:**

- **The index** (encrypted, one object): `format: 1`, `kind` (`full`, `update` or `return`), the
  company's name and UID (to refuse a package of another company), the sharer and the recipient
  (name, e-mail, role), the content version (`version`, `checksum`, B7), `base` (the version and
  commit it builds on; absent for `full`), the app version, and per file `{ path, object, blob,
  sha256, bytes }`. For the git side it also carries the version's commit and tree objects, which
  are small, so the recipient's app rebuilds the exact commit (a shallow root) from the files
  without a git bundle. For `full` it lists `omitted` (B3.5). A `return` names `basedOn`.
- **The files**, one encrypted object each. **The books' own files** (`ledger.json`,
  `books/*.jsonl`, `master-data/`, `knowledge/`, the settings, filings and seals) **go whole in
  every share**: they are small, and so every link can be shown on its own. **Receipts and
  statements go incrementally.**
- `changes.json` and its new receipts (for `return`): the change set of B5.1.

The app writes and reads the git side with isomorphic-git and needs no git program: a Mac without
the developer tools has none, and running the `/usr/bin/git` stub opens Apple's install dialog
(`src/platform/git-program.ts`).

| Kind | Made by | Carries | Typical size |
|---|---|---|---|
| `full`, the first share with this person | «Teilen» when this recipient holds no earlier version, or «Vollständig» | the books' files and every receipt and statement except the closed years' (B3.5) | about 60 MB in April (Q1's receipts and statements); up to about 250 MB at year end; up to about 300 MB while the previous year is still open |
| `update`, every later share | «Teilen» when the recipient holds an earlier version | the books' files, plus the receipts and statements new since that version | tens of MB (one quarter is about 60 MB of receipts) |
| `return` | «An Sandra Huber zurücksenden» on the recipient's Mac | his change set (B5.1) | kilobytes for bookings, plus any receipt he adds |

The sharer's app keeps, per recipient, the newest version that recipient holds: the newest one his
app fetched (the service reports the opening by the app) or that his return was based on. An
`update` whose receipts build on a version his Mac lacks (his import failed, a new computer) is
refused there without changing anything: «Diese Übergabe baut auf Version 11 auf, die auf diesem
Mac fehlt. Bitte Sandra Huber um eine vollständige Übergabe.»

### B3.5 Closed years stay out, and stay provable

A `full` package leaves out the receipts and statements (`transactional-data/<year>/receipts/`,
`…/bank-statements/`) of every year the books have closed (`closedThrough` at 31.12. of that year
or later). Everything else of those years comes along: their books, filings and seals, which are
small. The seals and `loadBooks` therefore work on the copy, and corrections that reach back
(`corrects`) can still be checked. **A closed year's receipts go along only on request:** «mit
Archiv 2025» under «Mehr» (owner decision).

`omitted` lists each left-out file as `{ path, blob, sha256, bytes }`. The tree objects in the
index name the same blob ids, so the recipient's app proves two things:

- **Nothing is missing for what it shows.** Every receipt that an entry of an open period links
  is present. A link to a closed-year receipt shows «Im Archiv bei Sandra Huber (Prüfsumme …)»
  instead of the PDF.
- **Integrity.** Each omitted file is in the list, and the list's hashes match the trees. The
  checksum of the version (B7) is computed over the same hashes, so the recipient checks it
  without the omitted files.

**The recipient never loses a closed year by saving.** His copy is a sparse checkout of the open
paths. When he saves, the app builds the new commit's tree from the base tree and replaces only
the subtrees he changed. A save whose tree drops a path of `omitted` is refused (a test proves
it). A year closed after the recipient got it stays in his copy as it was; a later `update`
removes nothing.

### B3.6 The page `<id>.share.<domain>`

The invitation's button opens one page (prototype: `web.html`). The page reads the key from the
fragment in the browser and never sends it. It offers two ways, both in v1:

**A. In the browser, read-only, on any device.** «Im Browser ansehen» loads the app's read-only
UI (the build of the audit export, `READONLY`) from the same origin, fetches the index, decrypts
it in the browser, and shows the books: journal, receipts, MWST, Änderungen. Receipts are fetched
and decrypted lazily, when a person opens one. A receipt the link does not carry (an `update`'s
older receipts, a closed year) shows «nicht in diesem Link». The banner: «Durchsicht · nur Lesen
· Version 12 · von Sandra Huber». Nothing is written; nothing is stored in the browser beyond the
session. This is the way for Windows, a phone, and a quick look.

**B. In the app, to work on the books (Mac).**

1. **Vanilla Accounting laden.** One button for this Mac: Apple chip or Intel, picked by the page
   (only Chromium browsers report the architecture through `navigator.userAgentData`; Safari does
   not, so the page offers the Apple-chip dmg and Intel as a small link). The dmg comes straight
   from the GitHub release. Pictures show the install as the Mac shows it: open the dmg, drag to
   Programme, start. **While the app is unsigned** a further picture shows «Systemeinstellungen ›
   Datenschutz & Sicherheit › Dennoch öffnen»: right-click › Öffnen no longer opens an unsigned app
   since macOS 15. «Schon installiert? Direkt öffnen» skips the step.
2. **Buchhaltung öffnen.** A button to `vanilla-accounting://open?share=<id>#<key>`. The page
   says: «Fragt der Browser, ob die Seite die App öffnen darf: Erlauben.» The app registers the
   scheme (`protocols` in `desktop/electron-builder.config.cjs`, the `open-url` event), fetches and
   decrypts the index and the files, verifies them, and opens the copy (B4). After that the page
   says «Sandra Huber sieht, dass du sie geöffnet hast».

States of the page, each a plain fact: expired («Dieser Link galt bis 15.11. 00:04. Bitte Sandra
Huber um einen neuen.»), withdrawn, spent (3 openings).

**The general download page** `<domain>/app` offers step B1 without a share.

**Prerequisite worth naming:** an Apple Developer ID. Signing and notarizing the dmg removes the
settings detour of step B1, which is the hardest step for Ernst. Until then the page must show it.

### B3.7 The `.vanilla` file: the offline way

The dialog's «Mehr › Als Datei sichern» writes the same package (B3.4: the index and the files in
one zip, unencrypted, or with a password: *open question 11*) as
`<Firma> – Buchhaltung v12 (2026-11-14).vanilla`. The person sends it any way she likes (a USB
stick, SwissTransfer). A double click opens the Mac app (`fileAssociations`, the `open-file`
event), which treats it exactly like a link. Returns work the same way. The file is also what the
dialog offers when the service refuses or cannot be reached.

### B3.8 Later, not now: an account for fiduciaries with many mandates

Phase 2, outside v1: a fiduciary such as Monika Frei may open an account to see all her mandates
in one overview. Login by an e-mail link or a passkey; the share keys she received are stored
encrypted for her (wrapped under a key only her login unlocks), so the service still cannot read
them. The owner side stays without an account. Its design is a spec of its own.

## B4. The fiduciary works in his own app

- **Opening.** The link or the file creates the copy in the app's own folder
  (`~/Library/Application Support/Vanilla Accounting/Treuhand/<UID>/`) and lists it under the
  recent books by the company's name. He never sees the folder or git. An `update` moves his copy
  forward. His unsent changes stay: they are records he changed, and an update that touches the
  same record shows it as a conflict on his side first («Sandra Huber hat diese Buchung
  inzwischen auch geändert»), with the same view as B6.
- **His name.** The identity of B2 makes him the author of every save.
- **The mode is «Durchsicht»** (owner decision; «Prüfmodus» stays the read-only export's). The
  top bar shows it as a fact: «Durchsicht für Sandra Huber · Malerei Huber GmbH · Version 12 ·
  geteilt am 14.11.»
- **«Warum? (für Sandra Huber)»**: in the entry editor, `reason` becomes a visible field, optional, one
  line, next to «Speichern». `edits.ts` keeps it as it does today.
- **A filed quarter stays as filed.** Q1 and Q2, sealed, stay sealed on his copy: the seals come
  along and `loadBooks` checks them. In a closed period his change is refused as today (403,
  `assertOpen`). The entry's detail then offers «Korrektur im offenen Quartal buchen». The
  correction carries `corrects: "2026-Q2"`, and its description names the original id (the golden
  rule; `src/accounting/correction.ts correctsFor`). The MWST tab shows its effect on the Q2 0535.
- **He cannot file.** «Abrechnung erstellen» reads «Einreichen macht Sandra Huber».
  Sharing onward is refused too (owner decision). Sealing, closing the
  year and the company settings are refused (`roleRefused`, B2).
- **He works without the AI.** Every step he takes is a hand step the app has already (MISSION:
  possible without the AI). Simple screens for him mean: no new mode beyond the role, and the
  editor keeps to one column at 1280 px and follows the system's text size.
- **«An Sandra Huber zurücksenden»** saves what is unsaved under his name, builds the `return`
  (B5.1), encrypts and uploads it to the same share (B3.3). No e-mail is needed: Sandra Huber's app
  sees it on the share card. It names the size and the count: «14 Änderungen, 2 neue Belege, 48 KB». He may send again
  later; each return carries what changed since the version he got, so a second return replaces
  the first on Sandra's side unless she has taken the first over.

## B5. The way back

### B5.1 The change set

A return carries **records by id**, not commits. `changes.json` lists, for every record he
changed, added or deleted since the version he got: its kind (entry, mapping, receipt,
transaction, a knowledge or master-data file), its id, `before` (the record in the shared
version), `after` (his record, absent for a delete), his «Warum?», and the time. Its new receipts
go along as files of their own. The index names `basedOn: 12` and the checksum of version 12.

Files under `knowledge/` and `master-data/accounts.json` are records too: a rule or a business's
file by its id, an account by its number. A text file without ids counts as one record.

### B5.2 The sharer sees it

When the return arrives (the share card fetches it, B3.3), the app shows the fact «Ernst Bühler hat
14 Änderungen geschickt · basiert auf Version 12» with «Durchsehen». The review is a detail of
Änderungen (`/changes/<id>`), and the return is a row in Verlauf («Zurück von Ernst Bühler · 14
Änderungen»). Nothing new goes in the dock.

**On top: the effect on the VAT figures.** Per open period: «Q3 2026 zu bezahlen» before → after,
and per filed period touched by a `corrects` entry its 0535 (bisher / korrigiert / Differenz).

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

Within each group, entries come by partner. «3 Zahlungen an Coop Pronto: 30 % privat auf 2451» is
one row that opens into its entries. **Per entry:** the date, the description, **before → after**
for the changed fields (debit, credit, code, amount, date), his «Warum?», **who made the booking he
changed** (Sandra Huber by hand, rule `swisscom-telefon`, the AI with its reason), and links to the
receipt and the payment (`hrefOf` with a period holding the date).

**Decisions, never hundreds of them.** «Übernehmen» per group and «Alles übernehmen» on top. Per
row: «Auslassen» (not taken over; the row shows «ausgelassen» as a fact) and «Frage zurück» (a
question to Ernst Bühler, kept on the row; it goes with the next share to him and shows on his side under
the entry). There is no approval per field.

### B5.3 Three-way merge by record

Sandra may keep booking while Ernst has the books: there is **no hold**. The merge is by record
against the shared version (the base):

| Base (version 12) → Sandra now | Base → Ernst | Result |
|---|---|---|
| unchanged | changed | his change applies |
| changed | unchanged (not in his set) | hers stays |
| changed | changed to the same | nothing to do |
| changed | changed otherwise | **conflict**: the row shows «Deine Version \| Version von Ernst Bühler», she picks one |
| deleted | changed | conflict |
| any | added (new id) | applies; a new entry on a payment Sandra booked meanwhile is a conflict on that payment |

Only the same record changed on both sides is a conflict. Two different entries of the same
payment are different records; the payment's balance check (the write door's existing checks)
then refuses what would not add up, and the row says why.

**A period Sandra filed meanwhile.** If Sandra filed and sealed Q3 after sharing, his changes
dated in Q3 cannot apply. Their rows say «Q3 ist inzwischen eingereicht» and offer «Als Korrektur
im offenen Quartal buchen»: the same correction with `corrects: "2026-Q3"` (golden rule 1).

**Taking over** goes through the write door as a person-type actor «Ernst Bühler (Treuhänder)»
(`{ kind: 'person', name, email, role: 'fiduciary' }`; the write door treats it as a person, so it
may change Sandra's manual entries, which she approved by taking over). It is **one save**: git
author Ernst, committer Sandra, trailers `Vanilla-Kind: return`, `Vanilla-Person: <Ernst's email>`,
`Vanilla-Approved-By: <Sandra's email>`, `Vanilla-Version: 13`. «Rückgängig» on that Verlauf row
takes the whole take-over back as a new save, refused for a record changed since and for a closed
period (then a correction, as always). After the take-over the books are at Version 13 (B7).

**Learning.** After the take-over, «Immer so?» offers rules from the patterns he corrected (B6).

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

## B7. The content version: a plain counter

The person needs one word for «which state of the books»: «Buchhaltung Malerei Huber GmbH ·
Version 12 · 14.11.2026», with a checksum underneath in small type («Prüfsumme a3f9 c21e 07bd»).

- **What counts up:** every share and every snapshot written as a file (B3), every return taken
  over (B5.3), and every sealed quarter. Not every click or save. A return says «basiert auf
  Version 12». After taking it over the books are at Version 13, or one higher than the newest
  version when Sandra shared with someone else meanwhile.
- **Milestones are named:** «Version 15 · Q3 2026 eingereicht» when `npm run seal -- 2026-Q3
  --close` (or the app's filing step) seals the quarter.
- **The checksum** is the SHA-256 over the sorted list of `path`, NUL, the file's SHA-256, newline,
  for every tracked file of the version except the version log itself. Shown: its first 12 hex
  digits in three groups. The recipient recomputes it from his copy plus `omitted` (B3.5), so the
  closed years' receipts count without being sent.
- **Shown in:** the top bar's company line and Firma, the share card, the invitation's subject,
  the page, the file name `<Firma> – Buchhaltung v12 (2026-11-14).vanilla`, the read-only export's
  banner («Prüfmodus · nur Lesen · Version 12») and the browser view's («Durchsicht · nur Lesen ·
  Version 12»), and Verlauf (a version is a row).
- **Distinct from `schema`.** The format versions (`BOOKS_SCHEMA`, `WORKSPACE_SCHEMA`) stay
  technical and are never shown as «Version».
- **Where it is stored (owner decision):** a version log `versions.jsonl` at the workspace's top, in
  `LAYOUT` and listed by `npm run doctor`, appended only, one line per version:

  ```json
  {"n":12,"at":"2026-11-14T16:42:00+01:00","kind":"share","to":"ernst@buehler.example","commit":"…","checksum":"sha256:…"}
  {"n":13,"at":"2026-11-20T09:10:00+01:00","kind":"return","from":"ernst@buehler.example","basedOn":12,"taken":12,"left":2,"commit":"…","checksum":"sha256:…"}
  {"n":15,"at":"2026-12-02T11:00:00+01:00","kind":"seal","label":"Q3 2026 eingereicht","commit":"…","checksum":"sha256:…"}
  ```

  The counter is the last line's `n`; the first event after this lands is Version 1. The log also
  holds what the sharer's app needs per recipient (the newest version he holds, B3.4), so a second
  Mac of the owner knows it too. Seals do not hash it, so a new line never touches a sealed
  quarter. The commit of each version also carries `Vanilla-Version: <n>`.
- **The format:** the owner gave his OK on 2026-11-14 (books format changes always need it,
  AGENTS.md «Versions and data format»). The log is a new file with its own `schema: 1` header line
  and changes no existing file, so neither `BOOKS_SCHEMA` nor `WORKSPACE_SCHEMA` takes a step.

## B8. Invariants this loop must keep

- **A filed quarter never changes.** Neither side changes a sealed record. A return that would
  change one is refused row by row (B5.3) and offered as a correction. A copy whose seals do not
  verify loads read-only (`SealBrokenError` on save), as today.
- **A person's change is never overwritten by the AI or a rule.** Ernst's entries arrive as a
  person's (`origin: 'manual'`, `by.kind: 'person'`). Every later classify run is a module actor,
  and the write door refuses it on those entries. A test proves it (B11).
- **Nothing reaches the books without the sharer.** A return changes nothing until she takes it
  over; «Auslassen» leaves her record as it is.
- **The key never reaches the service** (B3.2, B3.3): the link travels in the sharer's own
  e-mail, and the page and the app decrypt locally. The service never sees a booking, a receipt, a
  name or a figure.
- **Sandra can undo** the take-over as a whole, and any single change of his in an open period, as
  a new change under her name (ADR 0003 §4); his change stays in the history.

## B9. Notifications, without nagging

The memory rule applies: state facts, never remind of chores.

- Sandra Huber: «Geöffnet am 15.11. 19:04» on the share card; «Ernst Bühler hat 14 Änderungen
  geschickt» once, then the Verlauf row. No badge, no count of «unread», no «bitte prüfen».
- Ernst Bühler: «Durchsicht für Sandra Huber · geteilt am 14.11. · Version 12». No «noch nicht
  zurückgesendet» after n days.
- The link's end is a time («Verfügbar bis 15.11. 00:04»), never a countdown.

## B10. Data model: what changes, and the schema flags for the owner

| Addition | Where | Schema step? |
|---|---|---|
| `person { name, email }` | `desktop.json` (per device, not in the books) | no |
| `access.yaml` with `schema: 1` | workspace top, `LAYOUT.top` (`company`), listed by `npm run doctor` | **a new file with its own version**. The alternative, `people:` inside `belege.workspace.yaml`, would be `WORKSPACE_SCHEMA` 5 with a ladder step. **Owner decides** (Q-B1). |
| `versions.jsonl` with `schema: 1` | workspace top, `LAYOUT` | **a new file with its own version**; no step of the books' schema. **Decided** by the owner (B7). |
| the package (an encrypted index with `format: 1`, the files encrypted one by one, or a change set) | encrypted at the service, or a `.vanilla` file | no: the package is versioned on its own. The books inside are unchanged. |
| the recipient's copy: shallow root and sparse checkout, `omitted` kept beside it | `.git/shallow` and the app's folder on the recipient's Mac | no: git's own shallow format |
| `Vanilla-Person`, `Vanilla-Approved-By`, `Vanilla-Version` trailers | commit messages | no |
| who changed an entry | **derived from git**: the take-over's author | no |
| `by.who` (the person's email on `by.kind: 'person'`) | `JournalEntry.by` | **yes: `BOOKS_SCHEMA` 10 with a ladder step.** Seals hash `by`. Needed only if attribution must survive without git history. **Owner decides** (Q-B2). |

## B11. UI placement and i18n

- **The top bar:** the chip «Teilen» next to Export (⇧S) with its card (B3.1); the company line
  with «Version 12»; on the recipient's side the share fact and the mode.
- **Änderungen:** Verlauf rows for versions and returns, the review detail (B5.2).
- **Firma › Personen** (a new section of the company area, `src/app/areas/company/`): this Mac's
  person, `access.yaml`'s people and roles, the people one has shared with.
- **The entry editor** (`src/app/areas/journal/`): the field «Warum? (für …)».
- **Texts:** new keys under `share.*`, `people.*`, `review.*` and `version.*` in
  `src/app/i18n/locales/de.ts`, with `fr`, `it` and `en` matching (`tests/i18n.test.ts`). The
  refusals `roleRefused`, `shareBaseMissing`, `shareOtherCompany`, `shareTampered` and
  `shareServiceRefused` go into `src/types/api-error.ts`. Luca reads the review in Italian, so `it`
  must cover it fully. The page and the invitation template are `vanilla-share`'s and carry their
  own texts (de first; the invitation in the sharer's language). No text uses a family word (B3).
- **The browser view** is the read-only build of the app (B3.6), with the banner «Durchsicht · nur
  Lesen».
- **CSS:** `src/app/areas/changes/changes.css` and the shell's top bar, with the existing tokens.

## B12. Tests

**Unit and integration** (`npm test`):

- `tests/share-crypto.test.ts`: a package encrypts and decrypts file by file; a chunk swapped,
  cut or dropped fails; a wrong key fails; one file decrypts without the others. A fake service in
  the test process records every request: **no URL, header or body holds the key**, a path or a
  name.
- `tests/share-invite.test.ts`: the invitation fills the template (HTML and text), goes through
  the workspace's sending channel (a fake SMTP server), and carries the link; without a sending
  account the dialog gets the `mailto:` text. The confirmation e-mail carries only its token.
- `tests/share-package.test.ts`, on a temp workspace with a closed 2025 and an open 2026 and small
  made-up receipts:
  - `full` leaves out 2025's receipts and statements, `omitted` matches the trees, the seals
    verify on the copy, and the checksum is the same on both sides.
  - A second share is an `update` on the version the recipient holds and carries only the new
    receipts. Applied on a copy without its base, it is refused (`shareBaseMissing`) and nothing
    changes.
  - A save on the sparse copy keeps every omitted path in the tree.
  - The index's tree objects rebuild the exact commit on the copy.
  - Refused: another company's UID, a file whose hash does not match the index.
  - No git program is spawned (`gitProgram` stubbed to throw).
- `tests/share-merge.test.ts`: Sandra books after sharing (author A), Ernst changes an account, a
  code and an amount, splits one booking, links a receipt, books a depreciation, deletes one entry
  and corrects Q2 with `corrects` (author B). The review returns each change in its group with
  before/after, his reason, and who made the original. The merge applies what only he changed,
  keeps what only she changed, and reports exactly the records both changed as conflicts. A
  change in a quarter she sealed meanwhile is offered as a correction and never applied. The
  take-over is one save with author B and `Vanilla-Version`; its «Rückgängig» restores every
  record; a later classify run leaves his entries alone.
- `tests/content-version.test.ts`: share, take-over and seal each add one line; a plain save adds
  none; the file name and the banner name the version.
- `tests/identity-author.test.ts`: the desktop person becomes the commit author and the
  `Vanilla-Person` trailer. `GIT_AUTHOR_NAME` still wins.
- `tests/access-roles.test.ts`: auditor writes are refused, fiduciary filing and sealing are
  refused (`roleRefused`), a shared copy takes its role from the package, a missing `access.yaml`
  means owner.
- A row per new write route in `tests/period-lock.test.ts`.
- Browser tests (`launchChrome`): the review renders its groups and the VAT effect, «Alles
  übernehmen» applies, a learn offer opens the rule card. The browser view opens a share from the
  fake service by its fragment key, shows the journal, and fetches a receipt only when it is
  opened.

**Persona walk.** `.claude/skills/verify/personas/treuhaender.md` gains the scenario «Ernst,
family fiduciary» on two VMs, Apple's limit, so the simulator stays off (A2.4). The share service
runs as its local development server on the host, reachable from both VMs, and a local mail
catcher stands in for Sandra Huber's mail account:

1. VM `sandra` from snapshot `huber-q3`: she books Q3 with the AI, with three planted mistakes (an
   account, a VAT code on a receipt without Swiss VAT, a private lunch), then «Teilen…» to Ernst Bühler.
2. VM `ernst` (fresh, no app, no Claude): he opens the caught invitation's link, looks at the books in the
   browser first, installs the app from
   the page, opens the books, tells the app who he is, and corrects by hand: «Warum?» on two
   corrections, one correction of the filed Q2. Meanwhile Sandra books two more payments, one of
   them a record he also changes. Then «An Sandra Huber zurücksenden».
3. Back in `sandra`: the review. Judge: does she understand it without help? Does the conflict
   read plainly? Does she keep a rule from it? Does the next intake keep Ernst's changes? Is
   anything nagging?

Judge Ernst as written in B1: large text, one screen at a time, no technical question, debit and
credit by keyboard, and the page's install steps followed without help. Monika Frei's scenario
gets one step: a second share carries only what is new. Luca opens a read-only share in Italian
in the browser and finds Ernst's changes with author and
reason.

## B13. Phases and acceptance checks

| Phase | Work | Accepted when |
|---|---|---|
| B-1 Identity and version | `person` in desktop state, the question, `authorOf`, the trailers, names in Verlauf; the content version in `versions.jsonl` (B7) | in a fresh VM, two Macs saving the same repository show two names in Verlauf; `content-version` passes |
| B-2 The package and the file | the package (`full`, `update`, `return`; B3.4–B3.5), «Als Datei sichern», opening by double click, the recipient's copy and role, «An … zurücksenden» as a file | `share-package` passes; on books with a closed year of real size, `full` is no bigger than the open years' receipts plus their books, an `update` no bigger than the new objects, a bookings-only return under 1 MB |
| B-3 Review and merge | the review (B5.2), the three-way merge and the take-over (B5.3), «Warum?» in the editor, i18n de/fr/it/en | `share-merge` passes; Sandra (walk step 3) names what Ernst changed and why from the screen alone |
| B-4 Sharing by link | `src/share/client.ts`, the sender's confirmation, the invitation from the sharer's account, the dialog and card, the URL scheme, the page (in `vanilla-share`), the read-only browser view on per-share origins, «Zurückziehen» | `share-crypto` and `share-invite` pass; the walk's steps 1–2 work from the invitation without a terminal, a folder dialog or an account; Luca's step works in a browser without the app |
| B-5 Learning | the offers of B6 in the review | from the walk, at least one kept rule books the next quarter's matching payment as Ernst did |
| B-6 Roles and the shared repository | `access.yaml`, Firma › Personen, `roleRefused`, the loop over a git remote for people who have one | `access-roles` passes |
| B-7 (only if the owner says yes) | `by.who`, `BOOKS_SCHEMA` 10, ladder step | `npm test` and `test:books` green; sealed quarters intact after `npm run update` |

Outside this repository and worth naming: an Apple Developer ID (signing and notarization, B3.6).
Phase 2, not in this spec's phases: the fiduciary's account with all mandates (B3.8).

---

## Decided by the owner on 2026-11-14

These replace the first draft's recommendations and close the questions they answer:

- **Sharing by link**, end to end encrypted, through the share service; the `.vanilla` file is the
  offline way (B3; first draft: the file as default).
- **The invitation comes from the sharer's own mail account** (SMTP or Mail on this Mac), from a
  template of `vanilla-share`. The service never receives the key and sends no e-mail; it has no
  e-mail provider in v1 (B3.3).
- **The sender confirms her address once** against misuse of the upload API, by one e-mail the app
  sends to the service's inbound address (B3.3). Chosen as the simplest proof that needs no
  outgoing e-mail at the service.
- **Lifetime:** deleted 5 hours after the first opening, at the latest after 10 days; at most 3
  openings within those 5 hours (B3.2).
- **Limits:** 1 GB per share, 10 shares per sender address per day, 5 GB stored in total (B3.2).
- **The read-only view in the browser is in v1**, on a per-share origin `<id>.share.<domain>`,
  with every file encrypted on its own and an encrypted index, so receipts load lazily (B3.2,
  B3.4, B3.6). An account for fiduciaries with many mandates is phase 2 (B3.8).
- **No onward sharing** by a fiduciary (B2).
- **A closed year's receipts only on request** («mit Archiv 2025», B3.5).
- **The recipient's mode is «Durchsicht»** (B4). «Prüfmodus» stays the read-only export's.
- **UI wording is neutral:** the other person's name, or the neutral role where no name is known;
  never a family word (B3).
- **No hold while the books are shared.** The sharer keeps booking; a record-level three-way merge
  takes the return (B5.3; first draft: hold the owner's writes).
- **Take-over per group** with «Alles übernehmen», «Auslassen» and «Frage zurück» per row, one
  save, undoable as a whole (B5.2–B5.3; first draft: the fast-forward is the take-over).
- **A content version as a plain counter** with a checksum and named milestones, stored in
  `versions.jsonl` with its own schema; the books' schema is unchanged (B7; owner's OK given).

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
   now. The take-over's git author attributes every change. Revisit when an auditor must see
   authors in an export made without the repository.
8. **May a fiduciary mark a quarter «geprüft», and does that block anything?**
   *Recommendation:* he may mark it, as the role table says. It blocks nothing and shows as a
   fact on the MWST tab. Filing stays with the owner.
9. **Does «Frage zurück» need its own channel**, or is it enough that the question travels with
   the next share? *Recommendation:* with the next share; a reply to the invitation reaches the
   sharer for the urgent case.
10. **A sender whose mail provider fails DKIM/SPF alignment** cannot confirm by e-mail (B3.3).
    *Recommendation:* the `.vanilla` file for now; add another proof only if real users hit it.
11. **A password on the `.vanilla` file?** *Recommendation:* optional, off by default. The file
    goes the way the person picks; she decides.
