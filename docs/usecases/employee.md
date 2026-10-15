# Employee on the building site: Marco

Marco Rossi paints for Malerei Huber. He buys tape at the hardware store, fuel for the van, a
coffee for the customer. He photographs each receipt with the receipt app on his iPhone; Sandra
sees it on the Mac. He is not interested in accounting and will not open the desktop app. He
needs: scan, done, and once in a while a question answered.

Surface: the phone's upload simulated from the host against the VM (scenario `phone-sync`:
`POST /api/upload` as `ios/` sends it, see `src/server/routes/scan.ts` and the page `/scan`), on
the `huber-q3` snapshot. Findings will be in `.verify/findings/phone-sync.md`; none yet.

Format and status: [README.md](README.md).

### EM-01 Pair the phone

**Goal.** «Sandra hat gesagt, ich soll den Code scannen.»

**Happy path.** Sandra shows a QR code in the Mac app (host and a token for this phone); Marco
scans it in the receipt app; done.

**What goes wrong.**

**F1. There is no QR pairing yet; the app takes a typed address.** `not supported yet (docs/personas/employee.md)`
- Noticed: Marco types an IP address.
- By hand: Sandra types it for him.
- By wish: none.
- Learns: nothing yet.

**F2. A phone without a token uploads.** `untested`
- Noticed: should be refused (the token is the access control).
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: pairing and the token. Person: Sandra shows the code once.

**Test.** VM, `/scan`, an upload without a token.

**Status.** not supported yet

### EM-02 Send a receipt from the site

**Goal.** «Foto gemacht, fertig.»

**Happy path.** The photo uploads to the Mac's inbox, is read, matched to the payment and booked;
the phone shows «erhalten», later «gebucht».

**What goes wrong.**

**F1. The photo is not read without the AI.** `fails (usability#25, treuhaender-3)`
- Noticed: «in Arbeit» on the Mac.
- By hand: Sandra types it in.
- By wish: none.
- Learns: OW-04.

**F2. The phone shows no «gebucht».** `untested`
- Noticed: Marco does not know if it arrived.
- By hand: Sandra tells him.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: upload, deduplicate. AI: read. Person: nothing.

**Test.** VM `huber-q3`, upload `IMG_4502.jpg` as the app does.

**Status.** fails (usability#25)

### EM-03 The Mac is closed

**Goal.** (Sandra's laptop is shut; Marco scans at noon.)

**Happy path.** The phone keeps the receipt and retries until the Mac answers; nothing lost,
nothing doubled.

**What goes wrong.**

**F1. The upload fails and the photo is gone from the queue.** `untested`
- Noticed: Marco sees «nicht gesendet» with a retry.
- By hand: send again.
- By wish: none.
- Learns: nothing.

**F2. Retried twice after a timeout that did succeed.** `untested`
- Noticed: the second is a byte duplicate, refused on the Mac.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: queue and retry.

**Test.** VM: quit the app, upload, start the app, upload again.

**Status.** untested

### EM-04 Several at once, one twice

**Goal.** «Ich habe fünf Quittungen fotografiert, eine zweimal.»

**Happy path.** All arrive; the double one is caught as «schon da».

**What goes wrong.**

**F1. Two photos of the same receipt (not the same bytes).** `untested`
- Noticed: with the AI, «Duplikat?»; without, two receipts.
- By hand: Sandra deletes one.
- By wish: «das ist zweimal die gleiche Quittung».
- Learns: OW-11.

**F2. Parallel uploads lose one.** `untested`
- Noticed: four arrive.
- By hand: send again.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: dedupe.

**Test.** VM, five parallel uploads, one repeated.

**Status.** untested

### EM-05 A huge photo

**Goal.** (A HEIC of 10 MB from the newest iPhone.)

**Happy path.** Made smaller before its id (intake.md), read, kept.

**What goes wrong.**

**F1. Refused as too large.** `untested`
- Noticed: an error on the phone.
- By hand: none.
- By wish: none.
- Learns: nothing.

**F2. HEIC not understood.** `untested`
- Noticed: «unbekannt».
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: conversion.

**Test.** VM, upload a large HEIC-like file.

**Status.** untested

### EM-06 Not a receipt

**Goal.** (He photographs the finished wall for the customer.)

**Happy path.** Quarantine, «kein Beleg»; Sandra can take it back in.

**What goes wrong.**

**F1. Kept as a receipt.** `fails (mistakes-9 pattern, low)`
- Noticed: hidden as «kein Beleg».
- By hand: none.
- By wish: none.
- Learns: OW-12.

**F2. A receipt refused as «kein Beleg».** `untested`
- Noticed: Sandra sees it in «Nicht übernommen».
- By hand: «doch übernehmen».
- By wish: none.
- Learns: nothing.

**Automation target.** AI: kind. Person: Sandra.

**Test.** VM, upload `IMG_4590.jpg`.

**Status.** fails (mistakes-9)

### EM-07 A note on the receipt

**Goal.** «Material für Projekt Keller.»

**Happy path.** The app takes a note with the photo; the note is on the receipt; the AI uses it
for the account and the project.

**What goes wrong.**

**F1. The phone app has no note field.** `untested`
- Noticed: the note is missing.
- By hand: Sandra adds it on the Mac.
- By wish: none.
- Learns: nothing.

**F2. «privat bezahlt» in the note is ignored.** `untested`
- Noticed: OW-28.
- By hand: Sandra.
- By wish: none.
- Learns: the note decides who paid.

**Automation target.** AI: read the note.

**Test.** VM, upload with a note field (if the request has one).

**Status.** untested

### EM-08 Paid with his own money

**Goal.** «Ich habe das Benzin selbst bezahlt, ich will das Geld zurück.»

**Happy path.** The receipt books against a liability to Marco (an expense claim), not the
owner's Kontokorrent; the refund with his salary or a transfer clears it.

**What goes wrong.**

**F1. Booked on the owner's 2451.** `untested`
- Noticed: Sandra sees Marco's name.
- By hand: the employee's account.
- By wish: «Marco hat das selbst bezahlt».
- Learns: Marco's receipts with «selbst bezahlt» are his claims.

**F2. Paid back twice (salary and transfer).** `untested`
- Noticed: his account negative.
- By hand: book it back.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the claim account. Person: Sandra pays.

**Test.** VM, a receipt with no firm payment, note «selbst bezahlt».

**Status.** untested

### EM-09 A question back to him

**Goal.** (Sandra: «Marco, wofür war das?»)

**Happy path.** A question on his receipt reaches his phone; he answers there; the answer is on
the receipt.

**What goes wrong.**

**F1. There are no questions on the phone.** `not supported yet`
- Noticed: Sandra phones him.
- By hand: Sandra writes the note.
- By wish: none.
- Learns: nothing yet.

**F2. He answers in a word («Keller»).** `not supported yet`
- Noticed: the AI makes «Material Projekt Keller» of it.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the thread. AI: understand. Person: answer.

**Test.** When built.

**Status.** not supported yet

### EM-10 The paper receipt is lost

**Goal.** «Ich habe die Quittung verloren.»

**Happy path.** Sandra makes a substitute receipt (Eigenbeleg) on the payment: what, when, how
much, why; no input tax without the original.

**What goes wrong.**

**F1. The input tax claimed on the substitute.** `untested`
- Noticed: the substitute has no VAT number.
- By hand: I0.
- By wish: none.
- Learns: a substitute never carries input tax.

**F2. The original turns up later.** `untested`
- Noticed: two receipts for one payment.
- By hand: replace the substitute.
- By wish: none.
- Learns: OW-29.

**Automation target.** Code: the rule. Person: write the substitute.

**Test.** VM `huber-q3`, a payment without receipt.

**Status.** untested

### EM-11 Forward an invoice by mail

**Goal.** «Die Rechnung kam an meine Mail, ich leite sie weiter.»

**Happy path.** He forwards to the firm's receipt address; the mailbox source takes the
attachment.

**What goes wrong.**

**F1. The forwarded mail is from Marco, not the supplier.** `untested`
- Noticed: the sender rules do not match.
- By hand: Sandra drops it.
- By wish: none.
- Learns: forwarded mail from staff is taken.

**F2. The invoice is inline, not an attachment.** `untested`
- Noticed: «Mail ohne Anhang».
- By hand: Sandra prints it as PDF.
- By wish: none.
- Learns: inline PDFs are found (full source).

**Automation target.** Code: the source.

**Test.** VM with a made-up mailbox.

**Status.** untested

### EM-12 Fuel with the firm's card, partly private

**Goal.** «Ich habe am Wochenende auch getankt.»

**Happy path.** The private part to his salary deduction or to a claim on him; the rest fuel
with I81.

**What goes wrong.**

**F1. All of it as business.** `untested`
- Noticed: he says so.
- By hand: split.
- By wish: «die Hälfte war privat von Marco».
- Learns: nothing.

**F2. The private part booked to the owner.** `untested`
- Noticed: 2451.
- By hand: the employee's account.
- By wish: none.
- Learns: nothing.

**Automation target.** AI: suggest. Person: Sandra decides.

**Test.** VM, `IMG_4471.jpg` (the fuel receipt).

**Status.** untested

## Extending the automation

Marco makes no rules; Sandra makes them for his receipts. Each is a wish in her sidebar, tested
by an upload from the simulated phone afterwards.

| id | Sandra says | Becomes | The next upload must | Status |
|---|---|---|---|---|
| EM-X01 | «Belege von Marco sind immer Material für die Baustelle» | a rule by uploader | Marco's next hardware receipt on 4400 M81 | `untested` |
| EM-X02 | «wenn Marco tankt, ist es der Lieferwagen» | a rule by uploader and kind | fuel on 6200 | `untested` |
| EM-X03 | «frag Marco, wenn auf dem Beleg kein Projekt steht» | a question step to the phone | `not supported yet` (EM-09) | `not supported yet` |
| EM-X04 | «schick Marco jeden Freitag, welche Belege noch fehlen» | a schedule with a message | `not supported yet` | `not supported yet` |
