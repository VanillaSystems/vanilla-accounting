---
title: Belege aus Mails
summary: Ein Postfach verbinden, damit die App Rechnungen aus deinen Mails selbst holt. Was sie liest, wo das Passwort liegt, und was ohne IMAP geht.
section: start
order: 4
---
Viele Belege kommen per Mail: Abos, Online-Shops, Versandrechnungen. Die App kann sie selbst holen. Ein Postfach wird dafür eine **Quelle**: sie sagt, wo die App lesen darf, und sonst nichts.

## Ein Postfach verbinden

Du brauchst die Adresse, den IMAP-Server des Anbieters und ein Passwort, das IMAP annimmt. Bei den meisten Anbietern ist das ein **App-Passwort**, das du in deinem Konto beim Anbieter erstellst, nicht das Passwort aus dem Browser.

1. Firma › Quellen › «Postfach verbinden».
2. Trag ein: E-Mail-Adresse, IMAP-Server (ein Name wie `imap.anbieter.ch`), Login (meist wie die Adresse) und das App-Passwort.
3. «Verbindung prüfen». Die App meldet sich an und zeigt, welche Mails der letzten Tage die Quelle lesen würde. Sie holt dabei nichts.
4. Stimmt es, «Einschalten».

In Belege geht es auch über «Weg hinzufügen». Es fragt zuerst, an welche Adresse deine Rechnungen kommen, schaut nach, bei welchem Anbieter die Mails liegen, fragt, wo du sie liest, und schlägt einen Weg vor. Verlangt der Anbieter ein App-Passwort oder muss IMAP erst eingeschaltet werden, sagt es das. Wählst du «Postfach direkt verbinden (IMAP)», führt es dich zu Firma › Quellen, Adresse und Server schon eingetragen.

Einige Anbieter:

| Anbieter | IMAP-Server | Passwort |
|---|---|---|
| Gmail, Google Workspace | `imap.gmail.com` | Ein App-Passwort. Google verlangt dafür die Bestätigung in zwei Schritten. |
| iCloud Mail | `imap.mail.me.com` | Ein App-spezifisches Passwort. Das Login ist deine iCloud-Adresse, auch für eine eigene Domain. |
| Infomaniak | `mail.infomaniak.com` | Das Passwort der Mail-Adresse, nicht das deines Infomaniak-Kontos. |
| Andere | steht auf der Hilfeseite des Anbieters zum Einrichten eines Mail-Programms | meist das Passwort des Postfachs, mit Zwei-Faktor-Anmeldung ein App-Passwort |

## Das Passwort

Das Passwort liegt nie in der Buchhaltung. Die Mac-App legt es verschlüsselt im Schlüsselbund dieses Macs ab. Die Bücher sind ein Repository, das du vielleicht mit deiner Treuhand teilst: dort hat es nichts zu suchen.

Ein Passwort gehört auch nie in den Chat der KI. Es kommt ins Feld auf der Karte des Postfachs. Auf der Zeile des Postfachs in Firma › Quellen setzt oder ersetzt du es.

Aus dem Quellcode legst du das Passwort mit `npm run secret -- source:<name>:mail` in den Schlüsselbund, ohne dass es auf dem Bildschirm steht.

## Was die App liest

- Nur das Postfach, die Ordner und die Absender, die die Quelle nennt. Ein neues Postfach liest den Posteingang, von allen Absendern, täglich.
- Von jeder Mail, die seit dem letzten Mal kam, die angehängten PDFs. Sie kommen in den Eingang und gehen von dort durch dieselben Schritte wie jeder Beleg.
- Was die Bücher oder der Eingang schon haben, nimmt sie nicht noch einmal.
- Ein PDF, das laut seinem Text kein Beleg ist (Geschäftsbedingungen, ein Newsletter), legt sie in die Quarantäne. Ist es doch einer, legt «Ist ein Beleg» es in den Eingang.
- Die Quelle schreibt, sendet und löscht nichts im Postfach.

Ändert sich eine Quelle später, etwa ein anderer Absender oder eine andere Adresse, wartet sie wieder aufs Einschalten. So reicht sie nie weiter, als du zugestimmt hast.

Markierst du einen Anhang als «Kein Beleg», fragt die App: «Immer so? Anhänge von … künftig nicht mehr abholen.» Sie zeigt vorher, was sich ändert. Der Absender steht danach unter Firma › Quellen bei diesem Postfach.

## Wann die App holt

Der Ablauf «Belege und Daten holen» unter Automatisierung holt täglich von selbst. «Belege holen» in Belege holt sofort, statt auf den nächsten Lauf zu warten.

Fehlt ein Passwort oder lehnt der Server es ab, wird daraus eine Aufgabe unter Automatisierung › Aufgaben.

**In der Mac-App** gehen Postfach, Passwort und «Verbindung prüfen» schon, aber die App holt die Mails noch nicht selbst ab. Die Seite sagt das. Bis dahin ziehst du Rechnungen aus dem Postfach in Belege. Mit `npm start` holt die App selbst, und `npm run pull -- <name>` holt eine Quelle von Hand.

## Wenn IMAP nicht geht

Microsoft 365, Outlook.com und Hotmail nehmen kein Passwort über IMAP an. Sie verlangen eine Anmeldung über Microsoft, die die App noch nicht kann. Auch ein Google Workspace ohne App-Passwörter geht nicht direkt.

Dann bleiben diese Wege:

- **Weiterleiten.** Leg eine eigene Adresse nur für Belege an, bei einem Anbieter mit IMAP. Ein Filter in deinem Postfach schickt die Rechnungen dorthin, und die App liest nur diese Adresse. Zum Prüfen schick dir eine Mail mit «Rechnung» im Betreff.
- **Von Hand.** Zieh die PDFs aus deinem Mail-Programm auf die Seite Belege.
- **Handy.** Kassenzettel fotografierst du mit dem Handy, siehe [Handy koppeln](handy).

Alle drei enden im selben Eingang, die Schritte danach sind dieselben.

Was nach dem Eingang geschieht, steht unter [Erste Schritte](erste-schritte) und [Das Quartal](quartal).
