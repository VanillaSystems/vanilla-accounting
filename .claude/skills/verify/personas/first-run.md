# Scenario: the first half hour, with a score (clean image, no snapshot)

Sandra has downloaded the dmg and wants her third quarter in the app. Two runs of the same walk,
each in a VM of its own from `vanilla-clean`, with the persona files as `vm.sh up` puts them into
`~/Downloads`:

- `first-noai`: a Mac without Claude Code or Codex, which is what a new owner has. Never run
  `vm.sh claude` there. At the AI step, follow what the app offers as far as it goes without a
  credential, record what she faces at the login, then go on without an AI.
- `first-ai`: the same Mac with the AI ready (`vm.sh claude`), so the app leads.

The walk, in this order, as Sandra (painting firm, effective method, quarterly, the Treuhänder
kept a spreadsheet so far; she answers some questions by click and some in her own words, one of
them «weiss nöd, was heisst das?», one wrong and then corrected):

1. Open the dmg, get past macOS, first start (`first-noai` proves Gatekeeper once; `first-ai`
   takes the quick way of the skill).
2. The first screen, and new books for Malerei Huber GmbH.
3. The setup until the app lets her work.
4. Drop the Q3 statement and every PDF and photo from `~/Downloads` at once. Watch what the app
   does by itself; answer what it asks.
5. Find this quarter's VAT so far, and what is still missing before she can file.
6. `first-ai` only: one wish («Swisscom immer auf Telefon buchen») and one question («was muss
   ich jetzt no mache?») in the AI sidebar.
7. Read the books behind the screen (`fetch('/books.json')`): each booking's account and VAT
   code against its receipt.

## The score

Score every checkpoint from what you observed, never from what the code should do:
**2** she gets through alone, at the first try; **1** she gets through with friction (a second
try, a detour, a text she has to puzzle over, a part of it missing); **0** she stops, needs
knowledge she does not have, or is told something false. A checkpoint a run cannot reach
because an earlier one stopped her scores 0, and the report says so; one that does not apply to
the run is left out of its total.

| # | Checkpoint | 2 means | Runs |
|---|---|---|---|
| 1 | Install and first start | from the dmg to the app's first screen with no dialog that offers no way on, no crash, a window every time | noai |
| 2 | The first screen starts her books | she understands what the app is and the main button leads to new books | both |
| 3 | Getting an AI ready | she knows before she starts what it needs (an account, a plan, its price), sees no shell command she must understand, and can leave it for later without losing anything | noai |
| 4 | Setup: every question answerable | no question that needs accounting knowledge without a plain explanation or «Weiss nicht» | both |
| 5 | Setup: nothing twice, progress visible | no fact asked a second time; she sees how far she is; what she answered shows as answered | both |
| 6 | After setup she knows her first step | the last screen of the setup names it and leads to it | both |
| 7 | Statement in | read, balanced against the bank, and summed up in words (from when to when, how many payments) | both |
| 8 | Receipts in | read and matched where the files allow it, and every row says truly what happened to it | both |
| 9 | Payments booked without her | every payment code or the AI can decide is booked; what waits says why in her words | both |
| 10 | What the app asks her is answerable | each question or form can be answered from what she knows about her firm | both |
| 11 | After the drop she is where her data is | closing the drop leaves her in the period of her files, with a line on what came of them | both |
| 12 | The VAT figure | at most two clicks from the end of the drop, the right quarter, and honest about what is still open | both |
| 13 | «What is missing» | at most one click from the VAT figure, a list with links, no internal ids on the way | both |
| 14 | «What now?» to the AI | the answer names her open payments, receipts and the return, with links | ai |
| 15 | The books behind the screen | every booking on a sensible account with the right VAT code for its receipt | ai |

Count beside it, for both runs where they apply: minutes from first start to the first VAT
figure of Q3; questions asked in the setup (clicked and typed); words she has to read in the
setup; clicks from the end of the drop to the list of what is missing; payments booked by the app
of the 23 in the statement; seconds she waited on the AI.

## The report

The scored table with one line of evidence per checkpoint (the shot, the text on screen), the
counts, then the findings as the README says. For each checkpoint below 2: what exactly would
make it a 2. Compare with the round before
(`docs/0.4.0/usability/first-run-scores.md` holds every round) and name each checkpoint that got
worse: a round that raises the total and breaks a checkpoint is not a gain.
