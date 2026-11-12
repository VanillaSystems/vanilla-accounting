# First-run scores

One row per round of the scenario `.claude/skills/verify/personas/first-run.md`: the packed Mac
app on a fresh Mac VM, the made-up painting firm, once without an AI and once with. The
checkpoints and what 0, 1 and 2 mean are in the scenario. The findings of a round stay local
(`.verify/findings/`).

## Totals

| Round | Build | Without an AI | With an AI | Minutes to the first VAT figure (AI) | Setup questions (AI) | Clicks from the drop to «what is missing» | Payments booked by the app (AI / no AI) |
|---|---|---|---|---|---|---|---|
| 0 | 0.4.1 | 5 of 24 (21 %) | 10 of 26 (38 %) | 21, past a dead button only with a tester's workaround | 25 | 5 | 12 of 23 / 0 of 23 |
| 1 | 0.4.2-rc.35-gaa6d6edb | 13 of 26 (50 %) | 18 of 26 (69 %) | 11 | 8 | 2 | 18 of 23 / 0 of 23 |

Round 0 was scored afterwards by the coordinator from the two testers' reports of 2026-11-12;
the testers did not have the card. Each path was walked once.

Round 1 (2026-11-12) was scored by the testers with the card, on a build with seven of the eight
fixes of #339–#346 (not yet #344, the hand-booking form with a proposal). Two checkpoints fell:
the setup's first step now sends the person to Kontoauszüge, where dropped photos got no row and
the statement no sentence (#361).

## Checkpoints

| # | Checkpoint | 0.4.1 no AI | 0.4.1 AI | R1 no AI | R1 AI |
|---|---|---|---|---|---|
| 1 | Install and first start | 0 | not run | 0 | not run |
| 2 | The first screen starts her books | 0 | 0 | 2 | 2 |
| 3 | Getting an AI ready | 0 | – | 1 | – |
| 4 | Setup: every question answerable | 1 | 1 | 1 | 1 |
| 5 | Setup: nothing twice, progress visible | 0 | 0 | 2 | 1 |
| 6 | After setup she knows her first step | 1 | 1 | 1 | 1 |
| 7 | Statement in | 2 | 2 | 1 | 1 |
| 8 | Receipts in | 1 | 2 | 0 | 1 |
| 9 | Payments booked without her | 0 | 1 | 0 | 1 |
| 10 | What the app asks her is answerable | 0 | 2 | 0 | 2 |
| 11 | After the drop she is where her data is | not seen | 0 | 1 | 2 |
| 12 | The VAT figure | 0 | 0 | 2 | 2 |
| 13 | «What is missing» | 0 | 0 | 2 | 2 |
| 14 | «What now?» to the AI | – | 0 | – | 1 |
| 15 | The books behind the screen | – | 1 | – | 1 |
