---
title: Ein eingereichtes Quartal korrigieren
summary: Ein Fehler steckt in einem Quartal, dessen Abrechnung schon bei der ESTV ist. Die Korrektur kommt ins offene Quartal und in die Korrekturabrechnung.
section: faelle
order: 9
---
Ist die MWST-Abrechnung eines Quartals eingereicht, ändert sich dieses Quartal nie mehr, und jedes Quartal davor auch nicht. Seine Buchungen, seine Zahlen und seine Abrechnung bleiben, wie sie eingereicht sind. Taucht danach ein Fehler auf, wird er im nächsten offenen Quartal korrigiert und der ESTV mit einer Korrekturabrechnung (Formular 0535) für das betroffene Quartal gemeldet.

## Was die App selbst tut

- Sie lässt keine Buchung in einem eingereichten Quartal ändern, löschen oder neu erfassen, weder in der App noch von Hand in den Dateien.
- Unter Buchungen bietet eine Buchung eines eingereichten Quartals «Korrektur in … erfassen». Die App fragt «Was war falsch?»: der MWST-Code, das Konto oder die ganze Buchung. Daraus rechnet sie die Korrekturbuchung, datiert im offenen Quartal, mit dem Text «Korrektur zu» und der Nummer der alten Buchung.
- Die Korrekturbuchung trägt das Quartal, das sie korrigiert. Darum zählt sie nicht zur Abrechnung des offenen Quartals, sondern zur Korrekturabrechnung des eingereichten.
- Unter MWST zeigt sie für jedes eingereichte Quartal die Korrekturabrechnung: was bisher eingereicht ist, was heute aus den Büchern folgt, und die Differenz. Die Zahlen unter «korrigiert (eintragen)» trägst du im Portal der ESTV ein.
- Eine eingereichte Abrechnung erstellt sie nie neu.

## Was du entscheidest

Es gibt zwei Fälle, und sie werden verschieden behandelt.

- **Die Buchungen waren falsch.** Ein privater Einkauf war als Aufwand mit Vorsteuer gebucht, ein Beleg mit Schweizer MWST kam erst nach dem Einreichen, ein Code war falsch. Dann erfasst du eine Korrekturbuchung im offenen Quartal. Kam ein Beleg mit MWST nach, holt die Korrektur nur die Steuer nach, mit einem Code mit -2, nicht den ganzen Betrag.
- **Die Buchungen waren richtig, aber die eingereichte Abrechnung war falsch**, etwa weil ein Rechenfehler eine gebuchte Steuer weggelassen hat. Dann buchst du nichts. Die Korrekturabrechnung rechnet das Quartal aus den heutigen Buchungen neu, und die Differenz zeigt sich dort von selbst. Eine zweite Buchung würde die Steuer doppelt zählen.

Ob und wann du die Korrekturabrechnung einreichst, entscheidest du.

## Das Beispiel

Ein privater Einkauf war im eingereichten Quartal mit Vorsteuer gebucht. Die Korrektur nimmt die Vorsteuer zurück:

{{case correction-private-purchase}}

Ein Beleg mit Schweizer MWST kam erst, als das Quartal schon eingereicht war. Die Korrektur holt nur die Vorsteuer nach:

{{case vorsteuer-recovered-filed-quarter}}

Mehr zu den Codes: [I81 und -I81](mwst-codes#code-i81), [I81-2](mwst-codes#code-i81-2).
