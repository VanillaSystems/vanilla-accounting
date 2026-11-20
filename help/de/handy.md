---
title: Belege vom Handy
summary: Kassenzettel mit dem Handy fotografieren, und das Foto landet in den Belegen. Einmal koppeln, dann im selben WLAN.
section: start
order: 3
---
Mit dem Handy fotografierst du einen Kassenzettel, und das Foto landet im Eingang der offenen Buchhaltung. Dort liest die App es wie jeden anderen Beleg. Das geht mit der Scan-Seite im Browser des Handys, ohne App. Die iPhone-App «Vanilla Scanner» (Arbeitsname) ist noch nicht im App Store.

## Koppeln

Das Handy koppelst du einmal, mit einem Code, den der Mac zeigt. Handy und Mac müssen im selben WLAN sein.

1. In Belege «Belege vom Handy», oder unter Firma › Belege vom Handy, dann «Code zeigen».
2. Den Code mit der Kamera des Handys scannen. Er öffnet die Scan-Seite im Browser des Handys, schon gekoppelt.
3. macOS fragt, ob «Vanilla Accounting» eingehende Verbindungen annehmen darf: «Erlauben». Ohne das erreicht das Handy den Mac nicht.

Danach ist der Handy-Zugang an. In Belege steht beim Handy, ob es Belege annimmt.

## Fotografieren

Auf der Scan-Seite: «Foto aufnehmen». Hat ein Beleg mehrere Seiten, nimmst du mit «Weitere Seite» die nächste auf. «Hochladen» schickt alle Seiten als ein PDF an den Mac.

Steht auf einem Kassenzettel kein Datum, nimmt die App den Tag, an dem das Handy ihn aufgenommen hat. Der Beleg sagt das, und du kannst das Datum dort ändern.

## Was die App selbst tut

- Sie liest jedes Foto, sobald es ankommt, und ordnet es der Zahlung zu wie jeden anderen Beleg.
- Ein grosses Foto macht sie kleiner, bevor sie es ablegt.
- Schickt das Handy dieselbe Datei zweimal, nimmt sie sie einmal und sagt «schon da».
- Fotografierst du einen Beleg, den die Bücher schon haben, fragt Belege «möglicher Doppelbeleg». Bis du antwortest, bekommt er keine Zahlung.

## Was du entscheidest

Unter Firma › Belege vom Handy:

- **Einschalten** und **Ausschalten.** Der Zugang ist aus, bis du ihn einschaltest. Ausgeschaltet erreicht kein Handy den Mac. Der Code bleibt gültig: gekoppelte Handys kommen wieder durch, sobald er wieder an ist.
- **Neuen Code erstellen.** Danach kommt kein bisher gekoppeltes Handy mehr durch, bis es den neuen Code scannt. Das ist der Weg, wenn ein Handy verloren ging.

## Sicherheit

Der Mac öffnet im WLAN nur den Weg für Belege, und nur für Handys mit dem Code. Die Bücher selbst sind von dort nicht erreichbar.

Die Verbindung im WLAN ist nicht verschlüsselt. Wer im selben WLAN den Verkehr mitliest, könnte den Code sehen und Dateien in den Eingang schicken, aber nie die Bücher lesen. Eine solche Datei geht durch dieselben Prüfungen wie jeder Beleg.

## Ohne die Mac-App

Das Koppeln zeigt die Mac-App. Mit `npm start` zeigt das Terminal bei jedem Start die Adresse mit dem Code; ohne ihn nimmt der Mac nichts vom Handy an. Der Code ist bei jedem Start neu. Damit er bleibt, setzt du `VANILLA_PHONE_TOKEN` in der `.env` der App.

Andere Wege für Belege stehen unter [Belege aus Mails](mail) und [Erste Schritte](erste-schritte).
