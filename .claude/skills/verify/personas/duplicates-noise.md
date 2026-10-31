# Scenario: the same receipt twice, and things that are no receipt (snapshot huber-q3)

Sandra often adds a receipt more than once: the PDF from the mail, then a photo of the paper, then
the PDF again from the supplier's portal. And mail collection brings attachments that are no
receipt: order confirmations, newsletters, terms. Drop, one after the other:

- `IMG_4801.jpg`: a photo of invoice FM-77812, which is in the books already as a PDF
- `Farbmix_Rechnung_FM-77812 (1).pdf`: the same PDF bytes again
- `Farbmix_Auftragsbestaetigung_AB-5521.pdf`: the order confirmation of invoice FM-78230
- `Farbmix_Herbstaktion.pdf`: a newsletter; `Farbmix_AGB_2026.pdf`: terms and conditions

Judge: is each duplicate caught (and how: same bytes, same content); is the order confirmation
kept apart from the invoice (not a second receipt, not a second input tax); are the newsletter
and the terms kept out of Belege and the books, and can she get a wrongly refused file back;
does any duplicate claim input tax twice (check the books).
