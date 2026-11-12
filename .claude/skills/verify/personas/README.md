# Persona tests

A persona test drives the packed Mac app in a throwaway VM as a real owner would, with her
mistakes, and reports what helps and what hurts. Each scenario here is one test agent's job. The
tester never changes the app's code; a coordinator sorts the findings and hands them to fixers.

## The persona

Sandra Huber does the office of Malerei Huber GmbH in Wil SG: her husband Thomas runs the painting
business, two employees (Marco Rossi, Sandra herself on the payroll). Not technical, Swiss German,
careful but busy. She types the way she talks («bitte richtig eintragen»), uses wrong words
(«Quittung» for «Beleg», «Konto» for «Buchung»), clicks what looks clickable, and gives up when
she does not understand after two tries. Her files: `persona-files.mjs` (a Q3 2026 Raiffeisen
statement, supplier invoices with 8.1 % MWST, till-receipt photos, wrong files).

Two more personas walk the same first half hour ([first-run.md](first-run.md)'s checkpoints and
weights, three of their own each), for setups Sandra's painting firm never touches:
[first-run-webshop.md](first-run-webshop.md), Corinne Wyss of a tea webshop on Shopify (sales as
payouts over a clearing account, the orders export, fees and the platform's VAT, mixed rates, exports,
import VAT), and [first-run-consulting.md](first-run-consulting.md), Matthias Kälin of a one-person
consultancy (his own invoices, a client abroad in EUR, Bezugsteuer on software from abroad, private
outlays reimbursed, the phone's private share, a credit card the app does not read). Run Sandra for
every round, so the scores stay comparable with `docs/0.4.0/usability/first-run-scores.md`; run the
webshop when a change touches payment providers, sales reports, the drop of CSVs or imports, and the
consultancy when it touches sales and their questions, Bezugsteuer, foreign currency, the owner's
account or rules; run all three before a release. `vm.sh up <run> --persona webshop|consulting` puts
their files into the VM (`persona-files.mjs`, one module per persona under `persona-files/`), and
`answer-key.md` beside the env holds the figures the books should end with, computed by the generator.

## How a tester works

1. Start your own VM from a snapshot, never another tester's VM and never the person's desktop:
   `V=.claude/skills/verify/vm.sh; $V up <scenario> --from <snapshot>; export VERIFY_VM=<scenario>; $V app`
   then `source $TMPDIR/belege-vm/<scenario>/env; export CDP EVIDENCE PERSONA_IBAN_SPACED PERSONA_UID PERSONA_CAMT`.
   Snapshots: `huber-setup` (books set up, Claude Code in, no files yet), `huber-q3` (the whole
   Q3 dropped and booked). `vm.sh snaps` lists them.
2. Drive the app with `node .claude/skills/verify/app.mjs NAME 'STEP' …` (helpers in its head:
   clickText, fill, nth, pick, drop, wait, ev, p) and `$V shot NAME` for the whole screen. Read the
   printed text; look at the shots that matter.
3. Behave as Sandra: one goal at a time, her words, her mistakes. After a mistake, try to recover
   the way she would; if you cannot, that is a finding. To try a different mistake from a clean
   state, `$V down <scenario>` and `$V up <scenario> --from <snapshot>` again (20 s).
4. Check the books behind the screen when money is involved: `ev` with
   `fetch('/books.json')` gives receipts, transactions, mappings and journalEntries. A booking with
   the wrong VAT code or account is a finding of severity high, whatever the screen says.
5. Quitting mid-run: `$V sh 'osascript -e "quit app \"Vanilla Accounting\""'` within about 5 s
   of a drop, else the run has finished already; `$V app` starts it again.
6. Write findings to `.verify/findings/<scenario>.md` as you go (the coordinator reads them while
   you work), then `$V down <scenario>`. Evidence stays in `.verify/evidence/<scenario>/`.

## A finding

One line per finding in a table, newest last:

| id | area | severity | what Sandra did | what happened | what she expected | shot |

- id: `<scenario>-<n>`
- severity: blocker (she stops), high (wrong money or she is stuck), medium (friction), low
  (polish), good (keep it)
- Facts only: what was clicked or typed, what the app showed, what the books hold.

Model calls in the VM run on the owner's Claude subscription: no loops of hundreds of wishes;
a scenario is a session of a person, not a load test.
