---
title: Arten von Firmen und die MWST
summary: Nicht mehrwertsteuerpflichtig, effektive Methode oder Saldosteuersatz, vereinnahmt oder vereinbart. Was die App bei jeder Art anders macht.
section: nachschlagen
order: 3
---
Wie eine Firma mit der MWST abrechnet, stellst du einmal ein: beim Einrichten der Buchhaltung oder unter Firma › MWST. Die ganze App richtet sich danach. Die Methode gilt für ganze Jahre: sobald das offene Jahr Buchungen hat, lässt sie sich erst auf das nächste Jahr wechseln.

## Nicht mehrwertsteuerpflichtig

Eine Firma muss sich bei der ESTV anmelden, sobald ihr Umsatz aus steuerbaren Leistungen in einem Kalenderjahr {{threshold}} erreicht. Darunter ist sie nicht pflichtig.

- Jede Buchung ist brutto, ohne MWST-Code.
- Rechnungen der App weisen keine MWST aus.
- Die Firma reicht keine Abrechnung ein. Die Seite MWST zeigt stattdessen den Umsatz des Kalenderjahres neben der Grenze von {{threshold}}.
- Die Buchhaltung wird trotzdem pro Quartal geführt. Beim Jahresabschluss wird das ganze Jahr gesperrt.

Die Demo-Buchhaltung eines Coiffeursalons zeigt diese Art.

## Effektive Methode

Die Firma rechnet die Steuer auf ihren Umsätzen ab und zieht die Vorsteuer auf ihren Einkäufen ab. Sie rechnet pro Quartal ab, die Abrechnung ist {{due-days}} Tage nach dem Ende des Quartals fällig.

- Jede Buchung trägt einen MWST-Code: V für Verkäufe, M und I für Einkäufe, B für die Bezugsteuer. Siehe [MWST-Codes erklärt](mwst-codes).
- Vorsteuer gibt es nur, wenn der Beleg Schweizer MWST zeigt. Ohne Beleg bucht die App keine Vorsteuer, siehe [Ein Beleg fehlt](fall-fehlender-beleg).
- Die App erzeugt die Abrechnung (Formular 0550) als Datei für «MWST abrechnen» der ESTV.

## Saldosteuersatz

Die Firma zahlt einen von der ESTV bewilligten Satz auf ihrem Umsatz brutto, dafür zieht sie keine Vorsteuer ab. Sie rechnet pro Halbjahr ab (Formular 0553).

- Verkäufe bucht die App brutto mit dem Code des Saldosteuersatzes (F1, beim zweiten Satz F2).
- Einkäufe tragen keinen Code, denn es gibt keine Vorsteuer.
- Die Bezugsteuer auf Dienstleistungen aus dem Ausland ist geschuldet, ohne Abzug.
- Du trägst einen oder zwei bewilligte Sätze ein, wie auf der Verfügung der ESTV: den Satz, die Tätigkeit und den Tätigkeitscode. Ohne den Tätigkeitscode kann die App die Datei der Abrechnung nicht erzeugen.

Die Demo-Buchhaltung einer Schreinerei zeigt diese Art.

## Vereinnahmt oder vereinbart

Beide Methoden rechnen entweder nach vereinnahmtem oder nach vereinbartem Entgelt ab.

- **Vereinnahmt:** Ein Umsatz zählt in dem Quartal, in dem das Geld eingeht, ein Einkauf in dem Quartal, in dem du bezahlst. Das Datum der Zahlung entscheidet. So arbeiten alle Demo-Buchhaltungen.
- **Vereinbart:** Ein Umsatz zählt in dem Quartal, in dem die Rechnung gestellt wird, ein Einkauf in dem Quartal der Rechnung des Lieferanten. Die App bucht eine Rechnung, die sie selbst stellt, an ihrem Datum auf die Debitoren. Die Zahlung gleicht danach nur noch die Debitoren aus. Das ist die gesetzliche Grundform.
