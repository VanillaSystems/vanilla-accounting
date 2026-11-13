---
title: Auszahlungen eines Shops oder Kartenterminals
summary: Ein Zahlungsanbieter sammelt die Verkäufe, behält seine Gebühr und zahlt den Rest aus. Die Verkäufe laufen über ein Durchlaufkonto.
section: faelle
order: 6
---
Ein Webshop oder ein Kartenterminal nimmt das Geld der Kunden ein. Der Anbieter behält seine Gebühr und zahlt den Rest Tage später in einer Summe aus. Eine Auszahlung ist darum kein Verkauf: sie bündelt viele Bestellungen, Rückerstattungen und Gebühren. Damit jede davon richtig gebucht wird, laufen sie über ein Durchlaufkonto. Es hält, was der Anbieter der Firma noch schuldet.

## Was die App selbst tut

- Sie bucht die Auszahlung von der Bank gegen das Durchlaufkonto, ohne MWST. Dafür braucht sie keinen Beleg.
- Die Verkäufe bucht sie aus dem Verkaufsbericht des Anbieters, einer CSV-Datei, die du in der App ablegst. Jede Bestellung bekommt ihren eigenen Code: mit Schweizer MWST zum Satz, den der Bericht zeigt, ins Ausland V0. Jede Rückerstattung bucht sie mit Minus an ihrem eigenen Tag, jede Gebühr auf das Gebührenkonto.
- Jede Bestellung bucht sie nur einmal, auch wenn du denselben Bericht nochmals ablegst.
- Sie bucht nur die Bestellungen, die der Anbieter selbst eingezogen hat. Was über einen anderen Weg bezahlt wurde, etwa per Überweisung, zählt sie im Bericht mit, bucht es aber nicht aufs Durchlaufkonto.
- Die Prüfung des Quartals zeigt den Saldo des Durchlaufkontos und was der Anbieter nach dem Quartalsende noch ausbezahlt hat. Liegt der Saldo darüber oder unter null, nennt sie die Differenz.

## Was du entscheidest

- **Das Durchlaufkonto.** Beim ersten Verkaufsbericht fragt die App, auf welchem Konto die Verkäufe stehen, bis der Anbieter sie auszahlt. Es muss ein Bilanzkonto sein.
- **Den Umstellungstag.** Die App fragt, ab welchem Tag die Auszahlungen über das Durchlaufkonto gehen. Es ist ein Tag der offenen Periode. Was davor liegt, bleibt, wie es gebucht ist: die App bucht keine alte Buchung neu.
- **Was wartet.** Fehlt das Durchlaufkonto oder der Umstellungstag, bucht die App die Auszahlung nicht und sagt, was fehlt. Eine Bestellung im Inland ohne Steuer, Schweizer MWST auf einem Export oder eine Rückerstattung ohne eigenen Tag bucht sie auch nicht. Sie warten auf dich und stehen beim Verkaufsbericht.

Die App merkt sich deine Antworten in der Datei des Anbieters in deinem Wissen und fragt nicht nochmals.

Mehr zu den Codes: [V81](mwst-codes#code-v81), [V0](mwst-codes#code-v0).
