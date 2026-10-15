# Overnight run 2026-10-15/16: decisions and status

Ken asked (before sleeping) to continue without him: create personas, write exhaustive use cases
with their corner cases, test them, improve the app, iterate. MISSION.md is the yardstick. This
file records every decision a person might have made differently, newest last.

## Setup of the run

- A coordinator (the main session) sorts findings, hands batches to fix agents in their own git
  worktrees (`../261009-accounting-fix-<name>`, branch `fix/<name>`), merges into 0.4.0-drop after
  `npm test`, the real-books golden master (18 tests, read-only on the real books) and a look at
  the evidence.
- Test agents run the packed app in Tart VMs from snapshots (`huber-setup`, `huber-q3`; macOS runs
  two VMs at most) or the web sandbox (no model: the accountant without AI).

## Decisions

1. Android app: postponed until the iOS app is stable (Ken's lean). Receipt sync from the phone is
   tested by simulating the iOS app's upload (scenario phone-sync).
2. Customer payments without an invoice (VAT-registered firm): today booked at the zero code, which
   declares a domestic job as an export (Ziffer 220). Built as visible warnings (merged). A default
   of the standard rate with a note goes on a branch and is merged only if the real-books golden
   master stays unchanged; otherwise it waits for Ken.
3. Bilanz/ER net within the year (VAT legs to 2201): changes figures in every report and the
   golden master pins them; waits for Ken, with a plan.
4. VAT corrected by hand: the payment is booked again by the next run (needs Claude). Follow-up:
   without a model, the correction must adjust the booking's VAT code itself (mission: possible
   without the AI).
