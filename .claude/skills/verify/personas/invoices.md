# Scenario: writing invoices (snapshot huber-q3)

Sandra writes the invoices for Thomas's jobs. In Rechnungen she:

- sets up invoicing the first time (logo? IBAN, payment terms, the QR-bill), as she understands it
- writes an invoice to Familie Keller for painting a living room: hours and material, 8.1 % MWST
- makes mistakes: a wrong amount after issuing, the wrong customer, a discount, a credit note
- sends it (what «Senden» does on her Mac), a reminder when the customer does not pay
- sees the payment come in (the statement has the customers' payments; does a new invoice get
  matched when its payment arrives?), and whether the booking carries the VAT
- asks the AI sidebar for help once or twice in her words

Judge: can she produce a correct Swiss invoice with a QR-bill without help; is the VAT on the
invoice and in the books right; where is she lost.

## Phase 1 checkpoints (docs/specs/invoicing.md 5, «Phase 1»)

Walked on the demos, each opened as a copy (`npm start` with `VANILLA_WORKSPACE=<demo>`, or the
verify sandbox). Score each 0/1/2 as `first-run.md` defines («The score»), from what you observed,
with a screenshot per checkpoint. Sandra walks the coffee roaster (`demo/`, the closest firm to hers
on the effective method, cash basis), the consultant `demo-consulting/`, the joiner
`demo-schreinerei/`. The Treuhänderin walks P1.2 to P1.11 again by hand, without asking the AI;
each of those scores 2 only if she gets through so.

| # | Checkpoint | Where in the demos | 2 means |
|---|---|---|---|
| P1.1 | EUR Rechnung with a QR-IBAN set | `demo/`: Firma › Rechnungen, put a QR-IBAN on the EUR account and save; then Rechnung 2026-013 (EUR, München) | saving warns with the rule and what follows; without «Trotzdem speichern» the EUR Rechnung prints SCOR (RF…) with the plain IBAN; 2026-013 keeps what it printed |
| P1.2 | Painter's Rechnung by m² with a text title per room, a Zwischentotal per room, 3 % Rabatt on the total | `demo/`: a new Rechnung to any customer, unit m², two rooms | sheet and PDF right; totals per rate right; the Rabatt lowers each rate in proportion; issuing passes the Art. 26 check |
| P1.3 | Coffee 2.6 % and grinder 8.1 %, prices incl. VAT, 2 % Rabatt | `demo/`: Rechnung 2026-004 (Kaffeebar Beispiel); the draft of Café Exemple (titles, Zwischentotal, 5 % Rabatt) | the Rabatt splits over both rates to the Rappen on sheet and PDF (agreed basis: `RE-<n>` with both rates net of the Rabatt, checked in tests/invoice-events.test.ts or a copy switched to the agreed basis) |
| P1.4 | Payment 2 % short within the Skonto days of «10 Tage 2 %, 30 Tage netto» | `demo/`: Rechnung 2026-004, paid 11.08. by its QR reference | it reads «Bezahlt» in the tab «Bezahlt» (tabs «Alle · Entwürfe · Offen · Überfällig · Teilbezahlt · Bezahlt · Storniert» with counts and totals), the Skonto written off by code (Ausbuchungen: Skonto, «von der App»); no click set a status |
| P1.5 | One payment of CHF 3 180 for two Rechnungen of 1 620 and 1 580, CHF 20 short | `demo/`: Muster Catering AG, 2026-003 and 2026-005, payment of 10.09. (as generated: ausgeziffert); to walk it: «Lösen» on both, then «Ausziffern» on the payment | the dialog proposes both; the rest of the second booked as Spesen; both read «Bezahlt» |
| P1.6 | Customer bankrupt | `demo/`: Rechnung 2026-007 (Muster Hotel, teilbezahlt) | «Rest ausbuchen» as Verlust in three clicks; cash basis: no entry; it reads «Bezahlt» with the loss under its figures |
| P1.7 | Cash at the door; another by hand, then its statement line | `demo/`: 2026-016 (Bäckerei, on 1000 Kasse); 2026-010 (Café Exemple, by hand on 16.09., the Raiffeisen row of 18.09. confirms it) | the cash one: one Zahlungseingang on 1000 Kasse, «Bezahlt»; the bank one: one booking, the statement row named on the hand payment |
| P1.8 | Gutschrift for part of a Rechnung | `demo/`: 2026-011 (Beispiel Kantine) and its Gutschrift 2026-012 for 2 of 20 bags | applied at once; the Gutschrift reads «Abgerechnet»; the four figures show it under «gutgeschrieben»; the payment of the rest books revenue less the Gutschrift with the minus code |
| P1.9 | Two net rates | `demo-schreinerei/`: Rechnung 2026-001 (Küche, the appliances of activity 2), MWST tab H2 | the appliances' position books F2; the half year shows it in row 333 |
| P1.10 | Offene Posten on 31.12. | any demo: Verkauf › Offene Posten on 31.12.2026; the year close's receivables proposal | the same sum to the Rappen; it prints and exports CSV |
| P1.11 | Sent, downloaded, not sent | `demo/`: the tab «Nicht gesendet» (2026-017, 2026-018), the Versand column, Versendet | the tab shows the two with count and total; «Versand» shows date and channel for the others; the detail lists each send with recipient and checksum |
| P1.12 | Storno of a paid Rechnung | `demo/`: Rechnung 2026-001 (paid) › Stornieren | a warning names the payment, the rule and what follows; «Gutschrift statt Storno» is offered; «Trotzdem stornieren» leaves the payment unmatched; the log holds it as an ordinary entry |

The states the demos hold for the walk (tools/demo/kaffee-invoices.ts): sent by e-mail, downloaded
(2026-014, 2026-016), not sent (2026-017, 2026-018), partly paid (2026-007), overdue with a 1. Mahnung
(2026-006), Skonto (2026-004), short and written off as Spesen (2026-008), cash (2026-016), by hand
and confirmed (2026-010), ausgeziffert (2026-003, 2026-005), Gutschrift applied (2026-011/012),
cancelled (2026-015), a draft with position kinds, EUR with SCOR (2026-013). The consultant: the
mandate July to September (paid), the Munich audit in EUR (July paid, September open).
