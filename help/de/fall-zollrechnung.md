---
title: Zollrechnung eines Kuriers mit Einfuhrsteuer
summary: Ware aus dem Ausland kommt per Kurier, der Zoll und Einfuhrsteuer vorschiesst. Die Veranlagungsverfügung ist der Beweis.
section: faelle
order: 1
---
Die Firma bestellt Ware im Ausland. Der Kurier (DHL, FedEx, UPS, die Post) verzollt sie, zahlt Zoll und Einfuhrsteuer beim Bundesamt für Zoll und Grenzsicherheit (BAZG) und stellt beides mit seiner eigenen Gebühr in Rechnung.

## Was die App selbst tut

- Sie liest die Zollrechnung Zeile für Zeile und bucht jede Position auf ihr Konto: Zoll auf 4020, Einfuhrsteuer auf 4030, die Gebühr des Kuriers auf 4040.
- Die Gebühr des Kuriers trägt Schweizer MWST, wenn die Rechnung sie ausweist. Zoll und Einfuhrsteuer tragen keine.
- Die Einfuhrsteuer zieht sie erst als Vorsteuer ab, wenn die Veranlagungsverfügung MWST (eVV) des BAZG vorliegt und die Firma als Importeurin nennt. Dann bucht sie eine einseitige Zeile mit M81-2, die den Betrag der eVV in Ziffer 400 bringt.
- Kommt die eVV erst, wenn das Quartal schon eingereicht ist, bucht sie den Abzug als Korrektur im nächsten offenen Quartal.

## Was du entscheidest

- Die eVV holen, wenn sie fehlt. Die Rechnung des Kuriers allein ist kein Beweis für die Einfuhrsteuer: ohne eVV bleibt sie ohne Vorsteuerabzug.
- Einen Abzug, den du von Hand entfernt oder geändert hast, bucht die App nie wieder.

## Das Beispiel

{{case import-vat-evv}}

Mehr zu den Codes: [M0 und M81](mwst-codes#code-m81), [M81-2](mwst-codes#code-m81-2).
