# First-run scores

One row per round of the scenario `.claude/skills/verify/personas/first-run.md`: the packed Mac
app on a fresh Mac VM, the made-up painting firm, once without an AI and once with. The
checkpoints and what 0, 1 and 2 mean are in the scenario. The findings of a round stay local
(`.verify/findings/`).

## Totals, weighted as a funnel

From 2026-11-12 the total weights the checkpoints by where they lie (getting in × 3, setting up
× 2, first files and the result × 1; the scenario says why), and names where she stops. Rounds 0
and 1 are restated here on that scale from their checkpoint scores below.

| Round | Build | Without an AI | stops at | With an AI | stops at |
|---|---|---|---|---|---|
| 0 | 0.4.1 | 7 of 42 (17 %) | 1 install | 12 of 36 (33 %) | 2 the first screen |
| 1 | 0.4.2-rc.35-gaa6d6edb | 23 of 44 (52 %) | 1 install | 25 of 36 (69 %) | gets through |
| 2 | 0.4.2-rc.98-g8c451ad7 | 30 of 44 (68 %) | 1 install | 32 of 36 (89 %) | gets through |
| 3 | 0.4.2-rc.157-gafa23ac2 | 33 of 44 (75 %) | 1 install | 32 of 36 (89 %) | gets through |
| 4 | 0.4.2-rc.253-g91d22c35 | 33 of 44 (75 %) | 1 install | 32 of 36 (89 %) | gets through |
| 5 | 0.4.2-rc.361-g7ffa66f6 | 35 of 44 (80 %) | 1 install | 34 of 36 (94 %) | gets through |

Without an AI she still stops at the install: the app is not signed, so macOS refuses the first
double-click. No round of fixes can move that; it needs an Apple Developer ID.

## Totals, every checkpoint counted once (as first recorded)

| Round | Build | Without an AI | With an AI | Minutes to the first VAT figure (AI) | Setup questions (AI) | Clicks from the drop to «what is missing» | Payments booked by the app (AI / no AI) |
|---|---|---|---|---|---|---|---|
| 0 | 0.4.1 | 5 of 24 (21 %) | 10 of 26 (38 %) | 21, past a dead button only with a tester's workaround | 25 | 5 | 12 of 23 / 0 of 23 |
| 1 | 0.4.2-rc.35-gaa6d6edb | 13 of 26 (50 %) | 18 of 26 (69 %) | 11 | 8 | 2 | 18 of 23 / 0 of 23 |
| 2 | 0.4.2-rc.98-g8c451ad7 | 19 of 26 (73 %) | 23 of 26 (88 %) | not measured cleanly (the test rig waited on screen captures) | 8 | 1 without an AI, 2 with | 19 of 23 / 0 of 23 |
| 3 | 0.4.2-rc.157-gafa23ac2 | 20 of 26 (77 %) | 23 of 26 (88 %) | about 9 | 8 | 1 without an AI, 2 with | 19 of 23 / 1 of 23 |
| 4 | 0.4.2-rc.253-g91d22c35 | 20 of 26 (77 %) | 23 of 26 (88 %) | about 10 | 8 | 1 without an AI, 2 with | 19 of 23 / 1 of 23 |
| 5 | 0.4.2-rc.361-g7ffa66f6 | 22 of 26 (85 %) | 24 of 26 (92 %) | about 9–10 | 9 | 1 by the drop's link, 2 by the menu | 18 of 23 / 1 of 23 (9 more by her two rules) |

Round 0 was scored afterwards by the coordinator from the two testers' reports of 2026-11-12;
the testers did not have the card. Each path was walked once.

Round 1 (2026-11-12) was scored by the testers with the card, on a build with seven of the eight
fixes of #339–#346 (not yet #344, the hand-booking form with a proposal). Two checkpoints fell:
the setup's first step now sends the person to Kontoauszüge, where dropped photos got no row and
the statement no sentence (#361).

Round 2 (2026-11-13) had every fix of rounds 1 and 2 except two merged after its build (the
bank's fee row booked by code, #359, and the answer «Wir rechnen keine MWST ab», #347). No
checkpoint fell. Without an AI the windowless start after «Move» is gone and she still stops at
the install, on Gatekeeper alone. New and high: the hand-booking form proposed Swiss VAT on a sale
abroad (#382), and with an AI an order confirmation was set aside as «kein Beleg» (#384).

Round 3 (2026-11-13) had everything of rounds 1 to 3. With an AI the total did not move: receipts
in rose to 2 (the order confirmation stands beside its invoice), the books fell to 1 (the model put
a social-insurance payment whole on the liability account, #368). Without an AI getting an AI
ready rose to 2; she still stops at the install, on Gatekeeper alone. The sale abroad of round 2
is booked with the code for a service abroad on both runs. New and high: «Rückgängig» on a second
kept rule took back the first rule's bookings.

Round 4 (2026-11-13) had everything of rounds 1 to 4; its fixes were mostly for the two new
personas below. Neither painter total moved. Up: receipts in rose to 2 without an AI (eight of
nine paired by code), «what now» to 2 with one; «Rückgängig» of round 3 is fixed. Down on both
runs: «what is missing» to 1, because the open list's first sentence named a sales report's order
she does not have (#428). New and high without an AI: a receipt's VAT typed by hand was lost, and
the payment was then booked without input tax (#438).

Round 5 (2026-11-13) had the sixteen fixes of round 5 that were merged by then (#429–#443, #447,
#451 and others; the «Einschalten» gate #446 and the later ones came after the build). With an AI
she now gets through at 94 %: the setup says where method and basis stand (4 rose to 2), and the
open list's first sentence is true (13 back to 2). Down with an AI: the SVA payment is no longer
booked wrong but not booked at all, with its reason only in the run's detail (9 to 1, #470), and
the AI placed a 30 June balance at 1 January (14 to 1, #459). Without an AI the typed VAT of a photo
is kept and booked (10 to 2) and the open list's sentence is true (13 to 2); she still stops at the
install. No VAT figure was wrong in either run; Swisscom keeps CHF 0.02 too much input tax.

## Checkpoints

| # | Checkpoint | 0.4.1 no AI | 0.4.1 AI | R1 no AI | R1 AI | R2 no AI | R2 AI | R3 no AI | R3 AI | R4 no AI | R4 AI | R5 no AI | R5 AI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Install and first start | 0 | not run | 0 | not run | 0 | not run | 0 | not run | 0 | not run | 0 | not run |
| 2 | The first screen starts her books | 0 | 0 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 3 | Getting an AI ready | 0 | – | 1 | – | 1 | – | 2 | – | 2 | – | 2 | – |
| 4 | Setup: every question answerable | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 2 |
| 5 | Setup: nothing twice, progress visible | 0 | 0 | 2 | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 6 | After setup she knows her first step | 1 | 1 | 1 | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 7 | Statement in | 2 | 2 | 1 | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 8 | Receipts in | 1 | 2 | 0 | 1 | 1 | 1 | 1 | 2 | 2 | 2 | 2 | 2 |
| 9 | Payments booked without her | 0 | 1 | 0 | 1 | 1 | 2 | 1 | 2 | 1 | 2 | 1 | 1 |
| 10 | What the app asks her is answerable | 0 | 2 | 0 | 2 | 1 | 2 | 1 | 2 | 1 | 2 | 2 | 2 |
| 11 | After the drop she is where her data is | not seen | 0 | 1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 12 | The VAT figure | 0 | 0 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| 13 | «What is missing» | 0 | 0 | 2 | 2 | 2 | 2 | 2 | 2 | 1 | 1 | 2 | 2 |
| 14 | «What now?» to the AI | – | 0 | – | 1 | – | 1 | – | 1 | – | 2 | – | 1 |
| 15 | The books behind the screen | – | 1 | – | 1 | – | 2 | – | 1 | – | 1 | – | 2 |

## Other kinds of firm

From round 4 the same scenario is walked, with an AI, by two more personas: a webshop on a payment
provider (`first-run-webshop.md`) and a one-person consultancy GmbH with a foreign-currency account
and the owner's outlays (`first-run-consulting.md`). Each adds three checkpoints of its own (W1–W3,
C1–C3), counted once and kept out of the funnel total so the totals stay comparable.

| Round | Build | Webshop, funnel | stops at | Consultancy, funnel | stops at |
|---|---|---|---|---|---|
| 3 (first walk) | 0.4.2-rc.157-gafa23ac2 | 17 of 26, 72 % | gets through | 15 of 26, 64 % | gets through |
| 4 | 0.4.2-rc.253-g91d22c35 | 29 of 36 (81 %), 20 of 26 | gets through | 27 of 36 (75 %), 18 of 26 | gets through |
| 5 | 0.4.2-rc.361-g7ffa66f6 | 34 of 36 (94 %), 24 of 26 | gets through | 32 of 36 (89 %), 22 of 26 | gets through |

The first walks (rc.157) scored the totals only, not each checkpoint.

| # | Checkpoint | Webshop R4 | Consultancy R4 | Webshop R5 | Consultancy R5 |
|---|---|---|---|---|---|
| 2 | The first screen starts her books | 2 | 2 | 2 | 2 |
| 4 | Setup: every question answerable | 1 | 1 | 2 | 2 |
| 5 | Setup: nothing twice, progress visible | 2 | 2 | 2 | 2 |
| 6 | After setup she knows her first step | 2 | 2 | 2 | 2 |
| 7 | Statement in | 2 | 2 | 2 | 2 |
| 8 | Receipts in | 1 | 1 | 1 | 1 |
| 9 | Payments booked without her | 2 | 1 | 2 | 1 |
| 10 | What the app asks her is answerable | 1 | 2 | 2 | 1 |
| 11 | After the drop she is where her data is | 2 | 1 | 2 | 2 |
| 12 | The VAT figure | 1 | 1 | 2 | 2 |
| 13 | «What is missing» | 2 | 1 | 1 | 2 |
| 14 | «What now?» to the AI | 1 | 1 | 2 | 2 |
| 15 | The books behind the screen | 1 | 1 | 2 | 1 |
| W1 · C1 | The provider's report in · Customer payments | 1 | 2 | 2 | 2 |
| W2 · C2 | Sales over the clearing account · Software from abroad and the card | 2 | 1 | 2 | 1 |
| W3 · C3 | Fees, the platform's VAT and import VAT · Private outlays and the phone | 1 | 1 | 1 | 2 |

What held them down in round 4 became the issues of round 5: the setup's method and basis
(#423), after the drop (#424), the provider's payouts list (#425), a bill matched by its number and
the social-insurance share (#426), a balance sheet for the opening (#427), sentences true for the
firm (#428). No VAT figure was wrong in either walk.

Round 5: the webshop at 94 % (the payouts list named, the MWST page fresh, the two-rate cart booked
by its items, 2270 cleared; down: one of three Payments Invoices not read, #458, and the open list's
line for it naming the wrong document, #459); the consultancy at 89 % (the Wise opening at the ESTV
rate, the hotel's 3.8 % on its card line, Q3 after the drop; down: a false task on the hotel's
Kurtaxe whose button booked CHF 0.22 input tax, #455; the Akonto bill still not matched, #456).
