# Use cases

The use cases of Vanilla Accounting, per persona, written as test cases. They are the basis of
the persona tests (`.claude/skills/verify/personas/`): a tester takes a block, drives it in the
VM or the web sandbox, and writes the result back into the block's status.

The yardstick is [MISSION.md](../../MISSION.md): code does what a rule can decide, the AI does
what needs judgement, the person decides only what only they can decide. Every happy path has a
way to go wrong, and the way back decides whether a person trusts the books. So every block
names its failures first-class: how the app notices, how the person fixes it by hand, how by a
wish to the AI, and what the app learns from the fix.

## Files

| File | Persona | Prefix | Supported today |
|---|---|---|---|
| [owner-trades.md](owner-trades.md) | Sandra, who does the office of a painting GmbH on the side (the persona of the tests) | OW | yes |
| [webshop.md](webshop.md) | the owner of a small webshop: payouts, foreign currency, imports | WS | yes, parts untested |
| [it-consultant.md](it-consultant.md) | the IT consultant with clients abroad: EUR invoices, services abroad | IT | yes, parts untested |
| [treuhaender.md](treuhaender.md) | Monika, the Treuhänderin who keeps many clients' books, without an AI subscription | TH | partly |
| [auditor.md](auditor.md) | the ESTV or AHV auditor with a read-only copy | AU | partly |
| [employee.md](employee.md) | Marco, the employee on the building site who sends receipts from the phone | EM | partly |
| [not-registered.md](not-registered.md) | a firm not registered for VAT | NV | not supported yet |
| [saldo.md](saldo.md) | a firm that settles with the Saldosteuersatz | SS | not supported yet |

The personas themselves are described in [docs/personas/](../personas/README.md). A real
company mixes them: Sandra is owner, bookkeeper and, on Saturdays, the employee who scans.

## The format of a use case

```
### OW-07 One-line name

**Goal.** «In the persona's words, German where she would say it»

**Happy path.** What she does and what the app does, step by step, with the UI labels in
German as the app shows them.

**What goes wrong.**

**F1. A failure in one line.** `status`
- Noticed: how the app shows it, or how the person finds out.
- By hand: the way back without the AI (button, field, clicks).
- By wish: what she types into the AI sidebar (⌘J), and what should happen.
- Learns: what the app keeps so the next case of this kind is right without asking.

**Automation target.** Code: what a rule decides. AI: where judgement is needed.
Person: what only she decides.

**Test.** Surface (VM snapshot, sandbox, demo workspace), the files, and what to check in the
books (`fetch('/books.json')`), not only on the screen.

**Status.** untested | passes | fails, with the finding ids.
```

Every use case has at least two failures. A failure without a by-hand way is a finding by
itself: the mission says everything is possible without the AI.

The section **Extending the automation** at the end of each file lists wishes the persona would
make to automate more of her work: a rule, a workflow step, a change to the invoices, a report.
Each is a test case too: the wish, what the AI should show before she keeps it, what the next
matching case must do, and how she finds and takes the change back later.

## Status

Each failure and each wish carries its own status in backticks; the block's **Status.** line
sums them up.

| Status | Means |
|---|---|
| `untested` | no persona test has run it |
| `passes (id)` | a persona test ran it and it worked; the id names the finding (`.verify/findings/<scenario>.md`, or `usability#n` for [the first usability test](../0.4.0/usability/2026-10-15-malerei-huber.md)) |
| `fails (id)` | a persona test ran it and it went wrong |
| `fails (id), retest` | it failed, a fix landed after the test (the commit is named); it counts as failing until a test passes it |
| `not supported yet` | the app does not do it; the block says what the persona needs |

The block's line is the worst of its parts: `fails` when any part fails, `passes` when every
part passed, `partly` when some parts passed and none failed but some are untested, `untested`
when nothing ran.

## Surfaces and tools

All from `.claude/skills/verify/` (its SKILL.md says how):

- **The packed Mac app in a VM** (`vm.sh up <name> --from huber-setup|huber-q3`, `app.mjs`): the
  owner, the employee's phone upload, setup of other firms. Model calls run on the owner's
  subscription; keep a scenario to the session of one person.
- **The web sandbox** (`sandbox.sh up`): no model at all (the `claude` shim refuses), so it is the
  Treuhänderin without AI. `READONLY=1` gives the auditor's read-only mode. `VERIFY_WORKSPACE`
  picks the books: `demo/` (a coffee GmbH with a Wise EUR account, for the webshop),
  `demo-consulting/` (a consulting GmbH, for the IT consultant), or the Huber books copied out of
  the VM (`.verify/huber-books/`).
- **The persona files** (`persona-files.mjs`): the Q3 and October statements of the painting
  firm, supplier invoices, till photos and wrong files. A use case that needs another file says
  so; the file is made up and added to the generator, never taken from real books.

A booking with the wrong account or VAT code is a finding of severity high, whatever the screen
shows. Check the books behind the screen.

## What to test next

The fifteen corner cases with the most at stake that are untested or failing, ranked. A tester
starts at the top.

1. **OW-30 / OW-32** A hand correction (a VAT code, V0-E for a sale abroad) silently overwritten
   by «Neu klassifizieren» (misreads-10, misreads-11, misreads-19). Every correction must teach,
   never be overwritten.
2. **OW-22** Receipts not matched to their obvious payment when the receipt has no date yet
   (misreads-4): the matcher shows the model the wrong transactions.
3. **OW-29** A receipt linked by hand after the payment was booked: the booking keeps M0 and the
   input tax is lost (misreads-8).
4. **OW-36 / IT-07** A VAT-registered firm's customer payment without an uploaded invoice is
   booked at 0 % as an export (quarter-close-6, sidebar-wishes-14): output tax under-declared.
5. **OW-46** Bilanz & ER show VAT gross and no debt to the ESTV within the year (quarter-close-11).
6. **OW-26** Skonto: «Neu klassifizieren» books a one-leg entry, the Bilanz has a difference
   (misreads-14).
7. **OW-14** Delete a receipt, then «Rückgängig»: the receipt comes back, its input tax does not
   (regression-14); a second delete of the same file cannot be undone (regression-15).
8. **TH-05 / TH-06** Without a model: statement lines stay without any booking and nothing lists
   them as work (treuhaender-5); photos stay «in Arbeit» forever (treuhaender-3).
9. **OW-50 / TH-25** A mistake found in a filed quarter: correction entry in the open quarter,
   declared on the Korrekturabrechnung (0535). Untested end to end.
10. **OW-27** A supplier's credit note and a refund to the bank account: VAT reversed with the
    minus code, nothing booked twice. Untested.
11. **WS-02** A payout that bundles orders, refunds and fees: gross sales with VAT, fees apart,
    the clearing account at zero. Untested in a persona test.
12. **IT-19** A client in Liechtenstein: the app must book it as domestic (8.1 %), not as a
    service abroad. Untested.
13. **OW-41** The invoice sheet's selects (unit, VAT rate, customer) save nothing (invoices-6):
    the screen shows a VAT rate the invoice does not carry.
14. **TH-27** Asking the owner a question on an item and getting the answer back on it: not
    built; the Treuhänderin works by mail.
15. **EM-03** A receipt photographed while the Mac is closed: does the phone keep it and deliver
    it later, and is nothing lost or doubled? Untested.
