---
title: Rückerstattung eines Einkaufs
summary: Ein Lieferant zahlt Geld für einen Einkauf zurück, ohne Gutschrift. Die Vorsteuer, die du auf dem Einkauf abgezogen hast, geht zurück.
section: faelle
order: 3
---
Du hast bei einem Lieferanten eingekauft, und die App hat den Einkauf mit seinem Beleg gebucht, etwa mit I81. Jetzt kommt Geld zurück: eine Retoure, eine stornierte Bestellung, ein Teil des Betrags. Eine Gutschrift schickt der Lieferant nicht. Das ist kein Verkauf und kein Ertrag. Der Einkauf wird kleiner, und mit ihm die Vorsteuer, die du schon abgezogen hast.

## Was die App selbst tut

- Sie sucht den Einkauf, den die Zahlung zurückerstattet: eine gebuchte Zahlung an denselben Lieferanten, in derselben Währung, nicht später, mindestens so hoch wie die Rückerstattung. Nennt die Rückerstattung die Rechnungsnummer des Einkaufs, nimmt sie diesen.
- Findet sie genau einen Einkauf, bucht sie die Rückerstattung auf sein Konto, mit seinem Code und einem Minus davor: -I81 für einen Einkauf mit I81, -M81 für M81, -I0 für einen Einkauf ohne Vorsteuer. Für einen Teil gilt derselbe Satz. Die Buchung nennt den Einkauf.
- Sie bucht die Rückerstattung an ihrem eigenen Tag. Liegt der Einkauf in einem Quartal, das schon eingereicht ist, bleibt er, wie er ist: die Vorsteuer geht in der Abrechnung des Quartals der Rückerstattung zurück, nicht in einer Korrekturabrechnung.
- Eine Firmenregel für den Lieferanten, der Vorschlag im Buchungsformular und die KI buchen die Rückerstattung gleich.
- Nennt der Text der Zahlung eine gebuchte Rechnung («Gutschrift zu FM-78230»), nimmt die Rückerstattung den Code dieser Rechnung mit Minus.

## Was du entscheidest

- Findet die App keinen Einkauf, oder könnten es mehrere sein, bucht sie den Code ohne Vorsteuer mit Minus, also -I0 oder -M0, und sagt das in der Buchung. Das ist so, wenn:
  - zwei oder mehr Einkäufe gross genug wären und die Rückerstattung keine Rechnungsnummer nennt, die nur einer davon trägt (eine Karten- oder Terminalnummer zählt nicht);
  - andere Einkäufe zusammen genau den Betrag ergeben, etwa zwei zu 50 bei einer Rückerstattung von 100. Die App probiert dafür höchstens 20 kleinere Einkäufe des Lieferanten aus; gibt es mehr, findet sie keinen und sagt das in der Buchung;
  - der Einkauf auf mehrere Zeilen verteilt ist, mit zwei Codes oder mit einem Teil ohne Code, etwa auf einem Durchlaufkonto;
  - vom Einkauf schon so viel zurückgekommen ist, dass die Rückerstattung mehr wäre als der Rest. Ein Einkauf wird höchstens einmal ganz zurückerstattet. War der Einkauf mit Vorsteuer gebucht, änderst du die Buchung von Hand auf seinen Code mit Minus. Im Buchungsformular steht, woher der Code kommt.
- Ob es wirklich eine Rückerstattung ist. Zahlt der Lieferant aus einem anderen Grund, etwa weil er auch dein Kunde ist, ist es keine.

## Das Beispiel

{{case supplier-refund-without-credit-note}}

Mehr zu den Codes: [I81 und -I81](mwst-codes#code-i81), [I0](mwst-codes#code-i0). Die Rückerstattung an einen Kunden steht unter [Rückerstattung an einen Kunden](fall-rueckerstattung-verkauf).
