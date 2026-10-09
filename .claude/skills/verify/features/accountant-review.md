# Accountant review (review package, Prüfungen, Protokoll)

`npm run review` builds the audit export in review mode (src/audit/build.ts with a `review` snapshot); the Treuhänder's edits there become corrections in the browser (src/app/lib/review.ts over src/review/session.ts and corrections.ts) and download as one review file. The owner's **Prüfungen** tab and `npm run review:import` / `review:merge` turn it into a git branch and merge it (src/review/git.ts, src/server/routes/reviews.ts). The **Protokoll** tab reads the books' git history (src/books/history.ts). The spec it is checked against is docs/accountant-corrections.md. **Driven end to end on 2026-10-09 by `review-e2e.sh`.**

## Sub-features

- Review mode: blue review bar, **Prüfung** tab (corrections with before/after and VAT effect, undo, comments, sign-off, message, **Review abschicken**, **Datei laden**, earlier reviews' decisions), no model buttons.
- Corrections of every v1 kind: inline Soll, Haben, MWST, description; the entry form (date, amount, exchange rate, split, new entry, live VAT preview, chart accounts under «auch Konten ohne Buchungen»); delete or reverse; receipt link and unlink; «kein Beleg nötig»; comments on an entry and a receipt. A filed quarter's edit becomes a Storno and corrected entry with `corrects`; a filed link is refused.
- Owner: **Prüfungen** tab (drop or pick the file, the pull request with status per correction, merge all, merge selected, reject with a reason), the merge commit with two parents, `review/<branch>/decisions.json`, idempotent re-import.
- **Protokoll** tab: one row per commit of `books.json`, expandable to its records; in an export it reads `data/log.json`.

## How to get to it (user POV)

Owner: `npm run review -- 2026-Q3 --for "<name>" <folder>`, then the **Prüfungen** tab. Treuhänder: `npx serve <folder>`, edit in **Buchungen** and **Transaktionen**, then **Prüfung** → **Review abschicken**.

## Driving it with browse + sandbox.sh

```bash
.claude/skills/verify/review-e2e.sh review     # evidence in .verify/evidence/review/
```

The script runs the whole round trip in a sandbox of demo-consulting: `git init` of the sandbox workspace, the package built from it and served with `python3 -m http.server`, one correction of every v1 kind with screenshots, the review file captured from the real **Review abschicken** button (it wraps `URL.createObjectURL`), the upload in the owner's **Prüfungen** tab, a rejection with a reason, **Alle anwendbaren übernehmen**, the re-import, `git log --graph`, and `review-figures.ts`, which compares every merged VAT figure with the package's preview. `run.log` lists each step.

## Gotchas

- The sandbox workspace is not a git repository after `up`: run `git init` and one commit there, and keep the sandbox's own files (`api.log`, `bin/`, `env`, …) in `.gitignore`.
- The browse daemon is shared with other sessions, which can navigate your tab. The script starts its own (`BROWSE_STATE_FILE`, `BROWSE_PORT`); stop it with `browse stop` under the same variables.
- `browse` saves screenshots only under `/tmp` or `$TMPDIR`; the script copies them into the evidence folder.
- `sandbox.sh doctor` runs the `claude` shim, which reads stdin: give it `</dev/null` in a script.
- Rebuilding the package changes its manifest hash, and the review in the browser starts empty (localStorage is keyed by that hash).
- The package's `index.html` must be served over http(s): the manifest hash uses `crypto.subtle`, which needs a secure context (localhost is one).
