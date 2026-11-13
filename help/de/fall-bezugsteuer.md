---
title: Dienstleistung aus dem Ausland ohne Schweizer MWST
summary: Ein Anbieter im Ausland verrechnet keine Schweizer MWST. Die Firma schuldet sie selbst als Bezugsteuer und zieht sie gleich wieder ab.
section: faelle
order: 4
---
Die Firma bezieht eine Dienstleistung von einem Anbieter im Ausland: Software, einen Online-Dienst, Werbung, Beratung. Der Anbieter ist nicht im Schweizer MWST-Register und verrechnet keine Schweizer MWST. Die Leistung gilt als in der Schweiz bezogen, also schuldet die Firma die Steuer selbst. Das heisst Bezugsteuer.

## Was die App selbst tut

- Die KI liest auf dem Beleg, ob es eine Dienstleistung, eine Ware oder eine von der Steuer ausgenommene Leistung ist, und aus welchem Land der Anbieter kommt.
- Bei einer Dienstleistung aus dem Ausland bucht die App den Betrag mit B81-1. Sie tut das nur, wenn jeder verknüpfte Beleg gelesen ist und keiner Schweizer MWST oder eine CHE-Nummer zeigt. Zeigt ein Beleg eines davon, nimmt sie die Bezugsteuer zurück.
- B81-1 deklariert die Steuer in Ziffer 383 und zieht sie in derselben Buchung in Ziffer 405 wieder ab. Für eine rein geschäftliche Leistung bleibt nichts zu bezahlen.
- Eine steuerpflichtige Firma schuldet die Bezugsteuer ab dem ersten Franken. Die Grenze im Gesetz gilt nur für Firmen, die nicht steuerpflichtig sind.
- Mit Saldosteuersatz deklariert die Firma die Bezugsteuer in Ziffer 383, ohne Abzug.
- Ist der Betrag in Fremdwährung, rechnet die App ihn zum Tageskurs der ESTV um, siehe [Zahlung in Fremdwährung](fall-fremdwaehrung).

## Was du entscheidest

- Ob der Anbieter doch Schweizer MWST verrechnet. Viele grosse Anbieter aus dem Ausland sind in der Schweiz registriert und weisen {{rate-standard}} aus. Dann gilt die Vorsteuer auf ihrer Rechnung, nicht die Bezugsteuer. Der Beleg entscheidet.
- Ob es eine Ware ist. Für Waren gilt die Einfuhrsteuer, siehe [Zollrechnung eines Kuriers](fall-zollrechnung).
- Ob die Leistung von der Steuer ausgenommen ist, etwa die Gebühr eines Zahlungsabwicklers. Dann gibt es keine Bezugsteuer.

## Das Beispiel

{{case bezugsteuer-foreign-service}}

Mehr zu den Codes: [B81-1](mwst-codes#code-b81-1).
