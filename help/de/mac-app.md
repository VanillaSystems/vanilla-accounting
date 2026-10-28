---
title: Die Mac-App
summary: Installieren, beim ersten Mal öffnen, auf eine neue Version wechseln, und wo die Bücher liegen.
section: start
order: 2
---
Die Mac-App ist dieselbe App wie `npm start`, in einem eigenen Fenster. Du brauchst kein Terminal, kein Node.js und kein Homebrew.

## Installieren

1. Lade die `.dmg` von der Seite mit den Releases: `arm64` für einen Mac mit Apple-Chip, `x64` für einen Mac mit Intel.
2. Öffne die `.dmg` und zieh **Vanilla Accounting** in den Ordner «Programme».

Startest du die App direkt aus dem Download, fragt sie: «Vanilla Accounting in den Ordner «Programme» verschieben?». Mit «Verschieben» bleibt sie dort, auch wenn du das Download-Fenster schliesst.

## Das erste Öffnen

Solange die App nicht mit einer Developer ID von Apple signiert ist, lehnt macOS sie beim ersten Mal ab.

1. Öffne die App einmal. macOS meldet, dass sie blockiert wurde. Schliess die Meldung.
2. Öffne Systemeinstellungen › Datenschutz & Sicherheit.
3. Unten bei «Sicherheit» steht, dass Vanilla Accounting blockiert wurde. Klick daneben auf «Dennoch öffnen».

Danach öffnet die App mit einem Doppelklick.

Beim ersten Start öffnet sich «Einrichtung». Zuerst richtest du die KI ein, oder du gehst mit «Ohne KI weiter». Mehr dazu unter [Die KI, und ohne KI arbeiten](ki). Dann wählst du eine Buchhaltung, wie unter [Erste Schritte](erste-schritte) beschrieben.

## Wo die Bücher liegen

Die Bücher liegen in einem Ordner, den du wählst, nicht in der App. Für eine neue Buchhaltung schlägt die App einen Ordner «Buchhaltung» mit dem Jahr in deinen Dokumenten vor. Der Ordner ist ein Git-Repository, so bleibt jede Änderung nachvollziehbar.

Eine bestehende Buchhaltung öffnest du über «Bestehende Buchhaltung öffnen» oder Ablage › Buchhaltung öffnen…. Gemeint ist der Ordner, der die `belege.workspace.yaml` enthält. Ablage › Zuletzt geöffnet zeigt die letzten.

Passwörter und Schlüssel liegen nie in den Büchern. Die App legt sie verschlüsselt im Schlüsselbund dieses Macs ab: das Passwort des Postausgangs, die Passwörter der Postfächer, ein API-Schlüssel.

## Die Demo

«Demo ansehen» öffnet eine erfundene GmbH mit Belegen, Auszügen und Rechnungen. Du arbeitest in einer Kopie auf diesem Mac. Was du dort tust, bleibt in der Kopie und erreicht nie die Demo, die mit der App kommt. Ablage › Demo öffnet sie jederzeit.

## Eine neue Version

Lade die neue `.dmg` und ersetze die App im Ordner «Programme». Deine Bücher bleiben, wo sie sind. Öffnet die neue Version Bücher in einem älteren Format, bringt sie sie ins neue. Bücher aus der Zeit vor 0.4.0 bringt «Bücher ins neue Format bringen» auf den neuen Stand. Dabei ändert sich keine Buchung, und eine Sicherungskopie bleibt.

Welche Version du hast, zeigt Firma.

## Was macOS sonst fragt

- **Eingehende Verbindungen.** Schaltest du den Handy-Zugang ein, fragt macOS, ob «Vanilla Accounting» eingehende Verbindungen annehmen darf. Erst mit «Erlauben» erreicht das Handy den Mac. Siehe [Handy koppeln](handy).
- **Mikrofon.** Diktierst du in der KI-Spalte, fragt macOS einmal nach dem Mikrofon. Die Sprache wird auf dem Mac erkannt, kein Ton und kein Text verlässt ihn.
