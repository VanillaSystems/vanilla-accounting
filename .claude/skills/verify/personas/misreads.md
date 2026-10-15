# Scenario: what the app read wrong, and how Sandra puts it right (snapshot huber-q3)

Wherever Claude interprets (reading a receipt, its VAT, matching it to a payment, booking it), it
can be wrong. Sandra must be able to see what was read, put it right herself (by hand, without
Claude) and by a wish in the sidebar, and see why it was booked so. Drop the October statement
`camt053_Raiffeisen_Okt-2026.xml`, then these files, and look at what the app made of each:

- `Malerbedarf_Konstanz_RE-4471.pdf`: a German supplier, 19 % MwSt, paid CHF 386.60 for EUR 412.30.
  No Swiss VAT: no input tax. Did the app claim input tax? Can she correct it?
- `Rechnung_2026-031_Konstanz.pdf`: her own invoice for a job in Konstanz (Germany), no Swiss VAT,
  «Leistungsort Deutschland». The sale is not taxable in Switzerland; which code, which Ziffer?
- `Farbmix_Rechnung_FM-79010.pdf`: invoice total 1'537.20, paid 1'506.45 with 2 % Skonto. Does it
  match? How is the difference booked?
- `IMG_4733.jpg`: a crumpled, blurred till photo (total 187.35, VAT 8.1 %). Read right?

Then make the app wrong on purpose where it was right, and correct it each way:
- a receipt's amount and date wrong → correct by hand in Belege (Angaben bearbeiten), then check
  the payment link and the booking follow
- a receipt's VAT wrong (Swiss VAT where there is none, or none where there is) → is there any way
  without Claude? («Neu lesen (KI)» does not count as by hand)
- a booking on the wrong account or VAT code → correct by hand in Buchungen, and by a wish
- a receipt linked to the wrong payment → unlink and link the right one by hand
- «Neu klassifizieren» after a correction: does it keep her correction or overwrite it?
- why: can she see why a booking is as it is (which receipt, which rule, which run)?

Judge per case: what was read, right or wrong; the way to correct it by hand (exists? found
without help? clicks); the way by a wish; whether a correction survives the next run; what is
missing so that a person never depends on the AI to fix the AI.
