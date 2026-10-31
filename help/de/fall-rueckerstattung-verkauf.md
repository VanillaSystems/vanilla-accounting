---
title: Rückerstattung an einen Kunden
summary: Ein Kunde gibt Ware zurück und erhält sein Geld wieder. Die Rückerstattung kürzt den Umsatz und die geschuldete Steuer.
section: faelle
order: 2
---
Ein Kunde hat mit Schweizer MWST gekauft und bekommt sein Geld ganz oder zum Teil zurück. Das ist kein Aufwand und kein Einkauf. Der Umsatz wird kleiner, und mit ihm die Steuer, die die Firma der ESTV schuldet.

## Was die App selbst tut

- Sie bucht die Rückerstattung auf das Umsatzkonto des Verkaufs, mit seinem Code und einem Minus davor: -V81 für einen Verkauf mit MWST, -V0 für einen Export. So verlässt der Betrag die Ziffern 200 und 303, und die Steuer darauf geht zurück.
- Eine Rückerstattung über einen Zahlungsanbieter bucht sie aus seinem Verkaufsbericht, mit Minus und an ihrem eigenen Tag, siehe [Auszahlungen eines Shops](fall-shop-auszahlung). Nennt der Bericht keinen eigenen Tag dafür, bucht sie nichts: die Rückerstattung wartet auf dich.
- Eine Rechnung, die du in der App ausgestellt hast, korrigierst du mit einer Gutschrift. Die Gutschrift nennt die gebuchte Rechnung und nimmt ihren Code mit Minus.
- Eine Rückzahlung an einen Kunden direkt von der Bank bucht die KI mit dem umgekehrten Code des Verkaufs.

## Was du entscheidest

- Ob es wirklich die Rückerstattung eines Verkaufs ist. Geht Geld aus einem anderen Grund an einen Kunden, etwa als Darlehen, ist das kein kleinerer Umsatz.
- Ob der Verkauf mit MWST war oder ein Export. Davon hängt ab, ob -V81 oder -V0 passt.

## Das Beispiel

{{case webshop-refund}}

Mehr zu den Codes: [V81 und -V81](mwst-codes#code-v81), [V0](mwst-codes#code-v0).
