---
title: Erste Schritte
summary: Von der Installation bis zur ersten MWST-Abrechnung, in der Reihenfolge, in der du es brauchst.
section: start
order: 1
---
Diese Seite führt dich vom leeren Ordner bis zur ersten MWST-Abrechnung. Sie ist für die Inhaberin oder den Inhaber einer kleinen Schweizer Firma, die die Bücher selbst führen. Welche Firmen die App kennt, steht unter [Firmenarten](firmenarten), wie viel sie auf einmal nimmt, unter [Grenzen der App](grenzen).

## Installieren

Es gibt zwei Wege.

- **Die Mac-App.** Kein Terminal, kein Node.js. Wie du sie installierst und beim ersten Mal öffnest, steht unter [Die Mac-App](mac-app).
- **Aus dem Quellcode.** Du brauchst Node.js 22 oder neuer. Klone das Repository, dann `npm install` im Ordner der App. `npm start` startet die App, im Browser unter `http://localhost:5173`.

Belege lesen, Zahlungen zuordnen und Buchungen vorschlagen macht die App mit einer KI auf deinem Mac, über dein eigenes Abo. Ohne KI geht alles andere, von Hand. Mehr dazu unter [Die KI, und ohne KI arbeiten](ki).

## Die Buchhaltung anlegen

Eine Buchhaltung ist ein Ordner, getrennt von der App. Er hält die Bücher, die Belege und die Kontoauszüge deiner Firma. Er ist ein Git-Repository, so bleibt jede Änderung nachvollziehbar.

**In der Mac-App.** Beim ersten Start öffnet sich «Einrichtung». Zuerst geht es um die KI, dann fragt die App: «Neue Buchhaltung erstellen», «Vanilla-Accounting-Buchhaltung öffnen», «Von anderer Software übernehmen» oder «Erst die Demo ansehen». Später erreichst du dasselbe über den Startbildschirm oder das Menü Ablage › Neue Buchhaltung….

Die Einrichtung fragt nach der Firma, der MWST, ab wann gebucht wird und den Bankkonten. Mit KI ist es ein Gespräch, ohne KI fragt sie mit Knöpfen und Feldern. Wer lieber ein Formular ausfüllt, wählt «Ohne KI einrichten».

**Aus dem Quellcode.** `npm run init` stellt dieselben Fragen im Terminal. Zuerst wählst du ein Profil, das die Antworten vorausfüllt. Enter übernimmt eine Antwort. Danach zeigt `npm run doctor`, ob alles stimmt: jede Zeile beginnt mit ✓ oder ✗, und eine ✗-Zeile sagt, was zu tun ist.

Die Fragen im Überblick:

1. Firma: Name, UID, Inhaberin oder Geschäftsführer, was die Firma tut.
2. MWST: ob die Firma eingetragen ist, und wenn ja, Methode, Abrechnungsart und Periode. Was das heisst, steht unter [Firmenarten](firmenarten).
3. Was die Firma verkauft, ob sie importiert, ob sie Angestellte hat.
4. Die Bankkonten, eines pro Bank und Währung. Das Buchhaltungskonto schlägt die App vor. Die IBAN ordnet später jeden Kontoauszug dem richtigen Konto zu.

Methode, Periode und Satz der MWST gelten für ganze Jahre. Ändern lassen sie sich nur, solange das offene Jahr noch keine Buchungen hat.

## Den ersten Kontoauszug einlesen

Die App liest Kontoauszüge im Format **camt.053**, einer XML-Datei aus dem E-Banking. Manche Banken nennen ihn ISO 20022, XML oder «elektronischer Kontoauszug». Findest du ihn nicht, frag deine Bank nach «camt.053». Nimm camt.053, nicht camt.054 oder camt.052: deren Buchungen kommen im camt.053 ohnehin.

Öffne Kontoauszüge und zieh die Datei auf die Seite, oder drück `N`. Jeder Auszug zeigt den Anfangs- und Endsaldo der Bank, ob die Zahlungen dazu aufgehen, und den Saldo der Bücher daneben. Derselbe Auszug zweimal wird nur einmal gelesen.

Ein Auszug als PDF, Scan oder Foto geht auch. Dann liest die KI die Bewegungen, und die App prüft auf den Rappen, dass sie aufgehen. Erst dann liest sie den Auszug ein.

## Die ersten Belege

Zieh Belege auf das Fenster: PDFs, oder Fotos als JPG, PNG oder HEIC, bis {{files-per-drop}} Dateien auf einmal. In Belege geht es auch mit `N`. Jede Rechnung, jeder Kassenzettel, jede Zollrechnung: ein Beleg ist, was dir den Abzug der bezahlten MWST erlaubt.

Belege kommen auch von selbst: vom [Handy](handy) und aus [Mails](mail).

## Lesen, zuordnen, buchen

Nach jedem Hinzufügen arbeitet die App selbst. Eine Zeile unten links sagt, was sie gerade tut. «Eingang verarbeiten» in Belege startet es von Hand.

1. Sie liest die Auszüge und die Belege. Ein Foto wird ein PDF, aufrecht gedreht.
2. Sie liest die MWST auf jedem Beleg.
3. Sie ordnet jeden Beleg seiner Zahlung zu und legt ihn im Quartal ab.
4. Sie bucht jede neue Zahlung: Konto, MWST-Code, Kurs.

Danach siehst du nach. Belege zeigt zuoberst, was dich braucht, unter «Braucht dich»: einen Beleg ohne Zahlung, eine Zahlung ohne Beleg. Mit `L` verknüpfst du eine Zahlung. «Neu klassifizieren» bei einer Buchung in Buchungen bucht diese eine Zahlung noch einmal.

## Dich zurechtfinden

Links steht eine Liste, rechts das gewählte Stück. Die Bereiche sind im Dock am unteren Rand. Mit `G` und einem Buchstaben springst du hin:

| Taste | Bereich |
|---|---|
| `G B` | Belege |
| `G I` | Rechnungen |
| `G K` | Kontoauszüge |
| `G U` | Buchungen |
| `G M` | MWST |
| `G R` | Bilanz & ER |
| `G A` | Abschluss |
| `G F` | Firma |

Tasten, die überall gelten:

| Taste | Tut |
|---|---|
| `⌘K` | Einen Beleg, eine Buchung, ein Konto, einen Bereich oder eine Aktion finden |
| `↑` `↓` oder `J` `K` | Durch die Liste; `Esc` geht zurück zur Liste |
| `N` | Hinzufügen, je nach Bereich |
| `/` | Die Liste durchsuchen |
| `⌘Z` | Die letzte Änderung zurücknehmen |
| `⌘J` | Die KI-Spalte |
| `?` | Die Tasten des Bereichs zeigen |

Jede Seite hat ihren eigenen Link. Ohne Angabe zeigt eine Liste das offene Quartal.

## Die MWST-Abrechnung einreichen

Öffne MWST (`G M`). Dort steht die Abrechnung des Quartals: die Ziffern, zuoberst der Betrag, und zu jeder Ziffer die Buchungen dahinter.

Stimmt alles, erzeugt die App die Datei für «MWST abrechnen» der ESTV. Du lädst sie im Portal der ESTV hoch, prüfst und reichst ein. Danach ist das Quartal gesperrt: es ändert sich nie mehr. Ein Fehler darin wird im nächsten offenen Quartal korrigiert, siehe [Ein eingereichtes Quartal korrigieren](fall-korrektur).

Den ganzen Weg vom Quartalsende bis zur Sperre zeigt [Das Quartal](quartal). Welche MWST-Codes es gibt, steht unter [MWST-Codes erklärt](mwst-codes).
