---
name: verify
description: Launch and drive the Vanilla Accounting bookkeeping app (React UI on Vite + Express API on a workspace's books) in a disposable sandbox that clones the workspace, then prove UI, API, and CLI behavior with screenshots, dialogs, and an index diff. Also drives the packed Mac app (the dmg) on a fresh throwaway Mac VM, for installation, first run, setup, and persona or usability tests. Use whenever a change to src/app, src/server, or src/cli needs to be shown working in the real app, to check what a click actually writes to the books, or to see the app as a new owner gets it.
---

# Verify Vanilla Accounting

Belege is a single-page React app (Vite) backed by an Express API (`src/server/main.ts` starts it; `api.ts` assembles the routes in `src/server/routes/`). The API opens a workspace, the app's folder `vanilla-accounting/` of a company's repository (`src/workspace/workspace.ts`: `VANILLA_WORKSPACE`, else the first directory from the cwd upward that holds a `belege.workspace.yaml` or a `vanilla-accounting/` with one; layout in ADR 0013). It reads and writes the books there (`ledger.json` and `transactional-data/<year>/books/*.jsonl`, through `src/books/store.ts`), the year folders' `receipts/` and `beleg-import/`, and serves `/books.json` (the books as one JSON), `/receipts/*` and `/bank-statements/*` (found in whichever year folder holds them) to the UI. That workspace can be a company's real books, with quarters already filed with the ESTV. **Never verify against the user's running instance or the real workspace.** Always use the sandbox below.

All commands run from the repo root. `S=.claude/skills/verify/sandbox.sh` and `B=$(command -v browse)` are the shorthands used here and in `features/`.

## Launch

```bash
S=.claude/skills/verify/sandbox.sh
$S up my-run            # run-id optional; default v<timestamp>
```

`up` does the following, in about 2 s:

- It clones (APFS copy-on-write) the app's folder into `$TMPDIR/belege-verify/<run>/`, which then is a workspace of its own: `belege.workspace.yaml`, `ledger.json`, `master-data/accounts.json`, `knowledge/`, `history/`, `invoices.json`, `beleg-import/` and `transactional-data/<year>/` (`books/`, `receipts/`, `bank-statements/`, `invoices/`, and `filings/`, the filed VAT returns the MWST tab's Korrekturabrechnung reads); `data/` stays behind. The source is `$VERIFY_WORKSPACE` (a company's repository or its `vanilla-accounting/`), default `demo/` (set it to your repository to verify against your own books).
- No code is copied or linked. The API runs the repo's working tree with `VANILLA_WORKSPACE` set to the sandbox (and `cwd` there, so no repo `.env` is loaded), so every read and write lands in the clone. Vite runs from the repo and proxies `/api`, `/scan`, `/books.json`, `/receipts/*` and `/bank-statements/*` to the sandbox API, so the UI loads the cloned books and PDFs.
- It picks free ports starting at 3556 for the API and 5273 for the UI. It never uses 3456 or 5173, which belong to the user's `npm start`.

It is ready when it prints `ready`, followed by the env block (`UI`, `API`, `EVIDENCE`, PIDs, and the period lock `CT`, `CLOSED_Q`, `CLOSED_FROM`, `OPEN_Q`, `OPEN_FROM` that the recipes use). Load that env with `source $TMPDIR/belege-verify/<run>/env`.

The sandbox makes **no model calls**. Every model call goes through `src/llm/ask.ts`, which spawns the `claude` CLI, and the sandbox starts the API with `$SB/bin` first on its `PATH`, where a `claude` shim exits 1. Endpoints that call a model (Buchungen › `Neu klassifizieren`, Belege › `Neu lesen (KI)` through vision extract) answer 500 with `claude exited 1: verify sandbox: no model calls`, and the UI shows it in an alert. A closed-period refusal still comes first, as 403. If a verification truly needs a model, ask the user first. To drive the real code without one, put `tests/support/stub-bin/claude` at `$SB/bin/claude` instead.

Two sandboxes can run side by side because each one has its own ports, data, and Vite cache.

`READONLY=1 $S up my-run` starts the API in audit mode, as `npm run start:audit` does: every write answers 403 with `code: "readonly"`, and the UI shows the amber audit bar and hides its edit controls.

## Doctor

```bash
$S doctor my-run
```

The doctor is read-only. Every line must say `ok`. It checks that the PIDs are alive, that each port is owned by our PID, that the API's cwd and `VANILLA_WORKSPACE` are the sandbox, and that the API finds the refusing `claude` shim. It also checks `/api/status`, that the UI serves and compiles the app (its Vite config is `.verify/vite.<run>.config.mjs` in the repo, so it resolves the repo's node_modules) and proxies `/api` to this sandbox, that the UI serves the same books as the sandbox API (by SHA), a sandbox receipt PDF and a sandbox bank statement PDF (byte for byte), and that **the real workspace's books (`ledger.json` and every `books/*.jsonl`) are unchanged since `up`**. It prints the workspace's `closedThrough`. Run it first, and again whenever something looks off. If a line is `FAIL`, run `down` and then `up` instead of driving a half-working instance.

## Drive

**Browser (primary surface):** use gstack `browse` (headless Chromium, already installed). Open your own tab and close it when you're done. The daemon is shared with other sessions.

```bash
B=$(command -v browse)
$B newtab "$UI/journal?period=$OPEN_Q"      # the paths of docs/urls.md, e.g. /receipts/<id>?filter=offen&q=
$B wait --networkidle
$B snapshot -i -c                            # interactive elements as @e refs
$B click @e14 ; $B fill <sel> "text" ; $B press Enter
$B js "<expr>"                               # read DOM state / dispatch events
$B dialog                                    # alert() texts (the app reports API errors via alert, auto-accepted)
$B screenshot --viewport "$EVIDENCE/<feature>/NN-step.png"
$B closetab
```

These are the stable handles. They come from the source, not from coordinates.

- **Routes:** the paths of `docs/urls.md`, parsed only by `src/app/shell/route.ts`: `/receipts[/<id>]`, `/bank[/<account>-<yyyy-mm>[/<ref>]]`, `/payments/<ref>`, `/journal[/<id>]`, `/vat[/<ziffer>]`, `/vat/codes[/<code>]`, `/reports/income|balance|trial[/<account>]`, `/close[/<step>]`, `/company/<section>`, `/invoices…`. Query: `period=` (`2026`, `2026-Q1`, `2026-09`, `2026-07-01_2026-09-30`, `ytd`, `all`; absent = the open quarter after `closedThrough`), `q=`, `filter=zugeordnet|offen|ohneDatum`, `vat=`, `status=`. The language is no part of a link (a per-viewer preference, top bar › DE). Old `/<lang>/<period>/<tab>?receipt=&tx=&je=&account=&ziffer=&view=codes&code=` links redirect (replaceState) to the new path, so the recipes' old URLs still land on the right object. Changing area pushes a history entry, selecting a row replaces it. The heading's period button (`[data-testid=period-picker]`) and the top bar's period chip open the picker (`.pp`; `.pp .btn2.primary` applies). The static export keeps the path after `#`.
- **Areas and tabs:** the dock (`nav.dock`, shown near the bottom edge; `G` + letter: B Belege, I Rechnungen, K Kontoauszüge, U Buchungen, M MWST, R Bilanz & ER, A Abschluss, F Firma). MWST-Codes has no letter: `/vat/codes`, or **Codes erklärt** in MWST. Each area has its feature file (features/README.md). The list's heading is `.lhead h1`. ⌘K opens the palette (`.palette`), the top bar shows near the top edge (`.topbar`; mousemove with `clientY < 10`).
- **Journal rows:** `.rows.je .row[data-id="<journalEntry.id>"]`; its cells `.d`, `.t`, `.dr` (Soll), `.cr` (Haben), `.vc[data-vat]` (MWST), `.cu`, `.a`. The detail's form fields are `input[name=accountDebit|accountCredit|vatCode|amount|description]` (features/journal-entries.md).
- **Double-click:** `browse` has no dblclick command. Dispatch the event with `$B js "document.querySelector('<sel>').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"`. That fires the app's own React `onDoubleClick` handler.
- **Buttons by title or label:** `Neu klassifizieren` and `Löschen` (Buchungen), `Zahlung verknüpfen` and `Beleg löschen?` (Belege), `braucht keinen` and `Notiz` (Kontoauszüge), `Ausstellen` and `Senden` (Rechnungen). The search of Belege, Kontoauszüge, Buchungen, MWST-Codes, Bilanz & ER and of Rechnungen' customers and sent log is `.list .search input`; `/` focuses it.

**API:** `curl -s "$API/api/config"` and similar. Use it for side-effect checks and preconditions, never as a stand-in for the UI path you are verifying.

**CLI:** run the scripts from the repo with `VANILLA_WORKSPACE` set to the sandbox, so that they read and write the clone:

```bash
VANILLA_WORKSPACE="$SB" node --import tsx src/cli/vat-report.ts "$CLOSED_Q"
```

Never run `npm run <script>` without `VANILLA_WORKSPACE="$SB"` during verification. That run uses the real data.

## Evidence

Evidence goes to `.verify/evidence/<run>/<feature>/` in the repo. The folder is gitignored and survives `down`. `down` also copies `api.log` and `ui.log` there.

- `$S diff my-run` prints every collection, record, and field that changed in the sandbox's books since `up` (both read through `GET /books.json`) (`+`, `-`, `~ old -> new`). Save it as `index-diff.txt`. It is the side-effect proof for any mutation. It also catches *unexpected* writes, so a correct UI change alongside a stray write is a failed proof.
- Capture the action and the resulting state: a `before` and `after` screenshot, plus the `js`/`text` readback of the changed cell. A screenshot of the final screen alone is not proof.
- To prove a refusal (for example a closed period), capture the `$B dialog` text, take a screenshot, and run `diff` to show that nothing changed for that record.
- Drive the real user path, such as a double-click edit, a link through the panel, or a period switch. A `curl` PATCH proves the API, not the feature.
- Doctor's "real workspace books untouched" check is the isolation proof. Run doctor again at the end of every run.

## Cleanup

```bash
$B closetab                 # your tab only
$S down my-run              # kills the PIDs `up` recorded (and their children), deletes the sandbox, keeps evidence
$S list                     # should not list my-run
```

`down` kills only the recorded PIDs, never anything by process name. If `down` warns that a port is still listening, check `lsof -nP -iTCP:<port>`. If the process isn't ours, leave it alone. Run `down` after every failed attempt too.

## Helpers

- `sandbox.sh up|doctor|diff|down [run-id]` and `sandbox.sh list`. The run-id falls back to `$VERIFY_RUN`, then to the only existing sandbox.

## The packed Mac app on a fresh Mac (second surface)

The sandbox above runs the working tree in a browser. What an owner installs is the dmg: Gatekeeper, the first start, setup, the Electron shell, the bundled server. That surface runs only in a throwaway Tart VM cloned from `vanilla-clean` (macOS 26, user `admin`, password `admin`), never on the person's desktop: the app steals focus. `V=.claude/skills/verify/vm.sh`, `A=.claude/skills/verify/app.mjs`.

**Launch.** Build the dmg first (`npm run desktop:build`, about 3 min; it lands in `release/*-arm64.dmg`). Then:

```bash
$V up my-vm             # clone, boot, SSH key, Gatekeeper ON, dmg + persona files into ~/Downloads (≈1 min)
source $TMPDIR/belege-vm/my-vm/env   # RUN VM IP EVIDENCE DMG and the persona's PERSONA_IBAN, PERSONA_IBAN_SPACED, PERSONA_UID, PERSONA_CAMT; export VERIFY_VM=my-vm so later calls find it
```

Ready when it prints `ready`. `~/Downloads` then holds the dmg and made-up files of a painting firm (`persona-files.mjs`: a Q3 2026 camt.053 (`$PERSONA_CAMT`) for the IBAN `$PERSONA_IBAN`, the CSV a bank offers first, supplier PDFs with 8.1 % MWST, till-receipt photos, a holiday photo, a fake .docx, a duplicate PDF), all with the download quarantine flag, so macOS treats them like files from Safari.

**Doctor.** `$V doctor` (read-only): VM running, SSH, Gatekeeper on, screen capture over VNC, and after `$V app` the app's DevTools port. Every line `ok`, else `down` + `up`.

**Drive, outside the app** (macOS dialogs, Finder, System Settings) through the VM's screen sharing:

```bash
$V shot 02-gatekeeper           # whole screen → $EVIDENCE/02-gatekeeper.png and .s.png (1400 px wide)
$V click 700 573                # coordinates read off the .s.png; dclick double-clicks
$V type admin ; $V key enter    # a password field takes keys only after a click into it
$V sh 'open ~/Downloads/*.dmg'  # shell as admin; `open` = a double-click
$V put file.pdf                 # more files into ~/Downloads, quarantined
```

**Drive, inside the app** through its DevTools port. `$V app` (re)starts the installed `/Applications/Vanilla Accounting.app` with `--remote-debugging-port`, tunnels it to a free local port and writes `CDP` into the env; its stdout (the bundled server's log) goes to `/tmp/va.log` in the VM.

```bash
source $TMPDIR/belege-vm/my-vm/env; export CDP EVIDENCE PERSONA_IBAN_SPACED PERSONA_UID PERSONA_CAMT
node $A 04-setup "await clickText('Neue Buchhaltung anlegen')" "await fill('Firmenname','Malerei Huber GmbH')" "await nth(8, process.env.PERSONA_IBAN_SPACED)"
node $A 05-drop "await pick('PDFs hierher ziehen', ['swisscom_juli.pdf'])" "await wait(5000)"
```

Each call runs its steps, saves `$EVIDENCE/<name>.png` (the page) and prints the URL and the visible text. The steps and their helpers are in the head of `app.mjs`.

**Evidence** goes to `.verify/evidence/<run>/` like the sandbox's: `NN-step.png` and `.s.png` (whole screen), the page shots, and `app.log` (copied by `down`). The side effect of a step is read in the VM, for example `$V sh 'cat ~/Documents/"Buchhaltung Malerei Huber GmbH"/vanilla-accounting/belege.workspace.yaml'`.

**Cleanup.** `$V down my-vm` stops the tunnel it started, copies the app log, stops and deletes the VM; the evidence stays. `$V list` should not show it.

**Gotchas.**
- Synthetic drags over VNC never reach the app (Finder → window did nothing in two tries). Files go in with `drop([...])` (DevTools drag events with the files' paths, what a Finder drag delivers) or the app's own picker (`pick`).
- `screencapture` and Finder AppleEvents over SSH fail (no screen-recording or automation rights). Use `$V shot` and `open`.
- `vanilla-clean` has Gatekeeper off; `up` turns it on. A fresh clone has no SSH key; `up` installs it with the password.
- To get past Gatekeeper quickly after proving the dialog once: `ditto` the app from the mounted dmg to `/Applications` and `xattr -dr com.apple.quarantine` it. Moving it to Applications by hand makes macOS ask again.
- Before relaunching with a debug port, kill every app process (`$V app` does `pkill -9` on the bundle path); a leftover helper keeps 9222 and DevTools does not start.
- The VM has no `claude`. Reading a photo or a scan needs it; a persona test reports those paths as what an owner without Claude sees. To exercise them, `$V put tests/support/stub-bin/claude` and move it onto the app's PATH (see `tools/desktop/vm-e2e.sh`).
- Two VMs fit (8 GB each); stop one before a third.

## Feature map

See [features/README.md](features/README.md). Pick the feature file for what you changed and drive every entry point it lists.
