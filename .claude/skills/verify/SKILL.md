---
name: verify
description: Launch and drive the Vanilla Accounting bookkeeping app (React UI on Vite + Express API on a workspace's books.json) in a disposable sandbox that clones the workspace, then prove UI, API, and CLI behavior with screenshots, dialogs, and an index diff. Use whenever a change to src/app, src/server, or src/cli needs to be shown working in the real app, or to check what a click actually writes to the books.
---

# Verify Vanilla Accounting

Belege is a single-page React app (Vite) backed by an Express API (`src/server/main.ts` starts it; `api.ts` assembles the routes in `src/server/routes/`). The API opens a workspace (`src/workspace/workspace.ts`: `VANILLA_WORKSPACE`, else the first directory from the cwd upward that holds a `belege.workspace.yaml`), reads and writes ONE file there, `books.json`, plus the `receipts/` and `beleg-import/` folders, and serves `/books.json`, `/receipts/*` and `/bank-statements/*` to the UI. That workspace can be a company's real books, with quarters already filed with the ESTV. **Never verify against the user's running instance or the real workspace.** Always use the sandbox below.

All commands run from the repo root. `S=.claude/skills/verify/sandbox.sh` and `B=$(command -v browse)` are the shorthands used here and in `features/`.

## Launch

```bash
S=.claude/skills/verify/sandbox.sh
$S up my-run            # run-id optional; default v<timestamp>
```

`up` does the following, in about 2 s:

- It clones (APFS copy-on-write) the workspace layout into `$TMPDIR/belege-verify/<run>/`, which then is a workspace of its own: `belege.workspace.yaml`, `books.json`, `accounts.json`, `receipts/`, `bank-statements/`, `beleg-import/`, `history/`, `knowledge/`, and `filings/` (the filed VAT returns the MWST tab's Korrekturabrechnung reads). The source is `$VERIFY_WORKSPACE`, default the repo root when it holds a `belege.workspace.yaml`, else `demo/` (set it to your workspace to verify against your own books).
- No code is copied or linked. The API runs the repo's working tree with `VANILLA_WORKSPACE` set to the sandbox (and `cwd` there, so no repo `.env` is loaded), so every read and write lands in the clone. Vite runs from the repo and proxies `/api`, `/scan`, `/books.json`, `/receipts/*` and `/bank-statements/*` to the sandbox API, so the UI loads the cloned books and PDFs.
- It picks free ports starting at 3556 for the API and 5273 for the UI. It never uses 3456 or 5173, which belong to the user's `npm start`.

It is ready when it prints `ready`, followed by the env block (`UI`, `API`, `EVIDENCE`, PIDs, and the period lock `CT`, `CLOSED_Q`, `CLOSED_FROM`, `OPEN_Q`, `OPEN_FROM` that the recipes use). Load that env with `source $TMPDIR/belege-verify/<run>/env`.

The sandbox makes **no model calls**. Every model call goes through `src/llm/ask.ts`, which spawns the `claude` CLI, and the sandbox starts the API with `$SB/bin` first on its `PATH`, where a `claude` shim exits 1. Endpoints that call a model (`Neu klassifizieren`, `KI-Vorschlag`, vision extract, rename suggest and batch, receipt date) answer 500 with `claude exited 1: verify sandbox: no model calls`, and the UI shows it in an alert. A closed-period refusal still comes first, as 403. If a verification truly needs a model, ask the user first. To drive the real code without one, put `tests/support/stub-bin/claude` at `$SB/bin/claude` instead.

Two sandboxes can run side by side because each one has its own ports, data, and Vite cache.

## Doctor

```bash
$S doctor my-run
```

The doctor is read-only. Every line must say `ok`. It checks that the PIDs are alive, that each port is owned by our PID, that the API's cwd and `VANILLA_WORKSPACE` are the sandbox, and that the API finds the refusing `claude` shim. It also checks `/api/status`, that the UI serves and compiles the app (its Vite config is `.verify/vite.<run>.config.mjs` in the repo, so it resolves the repo's node_modules) and proxies `/api` to this sandbox, that the UI serves the sandbox books (by SHA), a sandbox receipt PDF and a sandbox bank statement PDF (byte for byte), and that **the real workspace's books.json is unchanged since `up`**. It prints the workspace's `closedThrough`. Run it first, and again whenever something looks off. If a line is `FAIL`, run `down` and then `up` instead of driving a half-working instance.

## Drive

**Browser (primary surface):** use gstack `browse` (headless Chromium, already installed). Open your own tab and close it when you're done. The daemon is shared with other sessions.

```bash
B=$(command -v browse)
$B newtab "$UI/$OPEN_Q/journal-entries"     # URL = /<period>/<tab>?filter=&q=&receipt=<id>&tx=<ref>
$B wait --networkidle
$B snapshot -i -c                            # interactive elements as @e refs
$B click @e14 ; $B fill <sel> "text" ; $B press Enter
$B js "<expr>"                               # read DOM state / dispatch events
$B dialog                                    # alert() texts (the app reports API errors via alert, auto-accepted)
$B screenshot --viewport "$EVIDENCE/<feature>/NN-step.png"
$B closetab
```

These are the stable handles. They come from the source, not from coordinates.

- **Routes:** `/<tab>` or `/<period>/<tab>`. The tabs are `receipts`, `transactions`, `bank-statements`, `journal-entries`, `trial-balance`, `balance-sheet`, `income-statement`, `vat-report`, `account-ledger`, and `bank-reconciliation`. The period is `2026`, `2026-Q1`, and so on. Query parameters are `filter=linked|unlinked`, `q=` (search on Belege and Transaktionen only), `receipt=<id>`, and `tx=<ref>`.
- **Tabs:** ARIA `tab` elements named `Belege`, `Transaktionen`, `Kontoauszüge`, `Buchungen <n>`, `Saldobilanz`, `Bilanz`, `Erfolgsrechnung`, `MWST`, `Kontoauszug`, and `Kontenabgleich`.
- **Journal rows:** `tr[data-rowid="<journalEntry.id>"]`, or `u:<txRef>` for an unclassified transaction. The cells use `td:nth-child(2)` for the description, 3 for Soll, 4 for Haben, and 7 for the MWST code. An editable cell is a `span[title="Doppelklick: bearbeiten"]`.
- **Double-click:** `browse` has no dblclick command. Dispatch the event with `$B js "document.querySelector('<sel>').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"`. That fires the app's own React `onDoubleClick` handler.
- **Buttons by title:** `Neu klassifizieren`, `Löschen`, `Zuordnen`, `Zuordnung entfernen`, `Beschreibung bearbeiten`, `Notiz bearbeiten`, and `Beleg löschen`. Search fields by placeholder: `Dateiname, Text suchen…`, `Ref, Beschreibung suchen…`, `Beleg suchen (Dateiname, Beschreibung)…`, and `Suchen…` on Buchungen.

**API:** `curl -s "$API/api/config"` and similar. Use it for side-effect checks and preconditions, never as a stand-in for the UI path you are verifying.

**CLI:** run the scripts from the repo with `VANILLA_WORKSPACE` set to the sandbox, so that they read and write the clone:

```bash
VANILLA_WORKSPACE="$SB" node --import tsx src/cli/vat-report.ts "$CLOSED_Q"
```

Never run `npm run <script>` without `VANILLA_WORKSPACE="$SB"` during verification. That run uses the real data.

## Evidence

Evidence goes to `.verify/evidence/<run>/<feature>/` in the repo. The folder is gitignored and survives `down`. `down` also copies `api.log` and `ui.log` there.

- `$S diff my-run` prints every collection, record, and field that changed in the sandbox `books.json` since `up` (`+`, `-`, `~ old -> new`). Save it as `index-diff.txt`. It is the side-effect proof for any mutation. It also catches *unexpected* writes, so a correct UI change alongside a stray write is a failed proof.
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

## Feature map

See [features/README.md](features/README.md). Pick the feature file for what you changed and drive every entry point it lists.
