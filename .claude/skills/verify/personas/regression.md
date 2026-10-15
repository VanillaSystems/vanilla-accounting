# Scenario: regression of round 1 (snapshots huber-setup and huber-q3)

Round 1 found these problems; the fixes are merged. Check each one again as Sandra would, on the
current build, and say per finding: fixed, partly fixed (what is left), or not fixed. Findings
tables of round 1: `.verify/findings/sidebar-wishes.md`, `mistakes.md`, `quarter-close.md`.

- sidebar: «bitte im Juni buchen» on a July payment (refused, plain reason); «das Natel ist zur
  Hälfte privat» (two bookings that add up, undo takes back both); a vague wish (a question back);
  the Details toggle; «du»
- mistakes: «Rückgängig» on a booked receipt (the payment booked again without it, nothing
  unbooked); delete a receipt (payment booked again without its VAT; «Rückgängig» in the toast
  restores it); re-drop an undone file in the same dialog; a camt of an unknown IBAN (plain
  message, «Bankkonto hinzufügen» prefilled); Tab saves in the receipt form; «28.6.26»
- books: a June invoice paid in July shows in Q3; customer payments without an invoice are named in
  MWST, Automatisierung and the payment (and can be marked «keine MWST darauf»); the opening balance
  offer in Automatisierung after the first statement (huber-setup: drop the camt, take the offer)
- anything new that broke
