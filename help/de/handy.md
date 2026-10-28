---
title: Handy koppeln
summary: Kassenzettel mit dem Handy fotografieren, und das Foto landet in den Belegen. Einmal koppeln, dann im selben WLAN.
section: start
order: 3
---
Mit dem Handy fotografierst du einen Kassenzettel, und das Foto landet im Eingang der offenen Buchhaltung. Dort liest die App es wie jeden anderen Beleg. Das geht mit der App «Belege» auf dem iPhone oder mit der Scan-Seite im Browser des Handys.

## Koppeln

Das Handy koppelst du einmal, mit einem Code, den der Mac zeigt. Handy und Mac müssen im selben WLAN sein.

1. In Belege «Handy koppeln», oder unter Firma › Handy.
2. **1 · App laden.** Scann den Code mit der Kamera deines iPhones. Er öffnet die App im App Store. Ohne iPhone gehst du gleich weiter: im 2. Schritt öffnet der Code die Scan-Seite im Browser des Handys.
3. **2 · Koppeln.** In der App «Belege» auf ⚙ › «Mit Mac koppeln» tippen und den Code scannen. Mit der Kamera gescannt, öffnet derselbe Code die Scan-Seite, schon gekoppelt.
4. macOS fragt, ob «Vanilla Accounting» eingehende Verbindungen annehmen darf: «Erlauben». Ohne das erreicht das Handy den Mac nicht.

Danach ist der Handy-Zugang an. In Belege steht beim Handy, ob es Belege annimmt.

## Fotografieren

In der App «Belege» oder auf der Scan-Seite: «Foto aufnehmen». Hat ein Beleg mehrere Seiten, nimmst du mit «Weitere Seite» die nächste auf. «Hochladen» schickt alle Seiten als ein PDF an den Mac.

Steht auf einem Kassenzettel kein Datum, nimmt die App den Tag, an dem das Handy ihn aufgenommen hat. Der Beleg sagt das, und du kannst das Datum dort ändern.

## Was die App selbst tut

- Sie liest jedes Foto, sobald es ankommt, und ordnet es der Zahlung zu wie jeden anderen Beleg.
- Ein grosses Foto macht sie kleiner, bevor sie es ablegt.
- Schickt das Handy dieselbe Datei zweimal, nimmt sie sie einmal und sagt «schon da».
- Fotografierst du einen Beleg, den die Bücher schon haben, fragt Belege «möglicher Doppelbeleg». Bis du antwortest, bekommt er keine Zahlung.

## Was du entscheidest

Unter Firma › Handy:

- **Einschalten** und **Ausschalten.** Der Zugang ist aus, bis du ihn einschaltest. Ausgeschaltet erreicht kein Handy den Mac. Der Code bleibt gültig: gekoppelte Handys kommen wieder durch, sobald er wieder an ist.
- **Neuen Code erstellen.** Danach kommt kein bisher gekoppeltes Handy mehr durch, bis es den neuen Code scannt. Das ist der Weg, wenn ein Handy verloren ging.

## Sicherheit

Der Mac öffnet im WLAN nur den Weg für Belege, und nur für Handys mit dem Code. Die Bücher selbst sind von dort nicht erreichbar.

Die Verbindung im WLAN ist nicht verschlüsselt. Wer im selben WLAN den Verkehr mitliest, könnte den Code sehen und Dateien in den Eingang schicken, aber nie die Bücher lesen. Eine solche Datei geht durch dieselben Prüfungen wie jeder Beleg.

## Ohne die Mac-App

Das Koppeln zeigt die Mac-App. Mit `npm start` setzt du `VANILLA_PHONE_TOKEN` in der `.env` der App. Das Terminal zeigt dann beim Start die Adresse mit dem Code.

Andere Wege für Belege stehen unter [Belege aus Mails](mail) und [Erste Schritte](erste-schritte).
