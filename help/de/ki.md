---
title: Die KI, und ohne KI arbeiten
summary: Was die KI tut, was die App ohne sie erledigt, was immer du entscheidest, und wie du ganz ohne KI arbeitest.
section: start
order: 5
---
Jede Arbeit in den Büchern geht an den, der sie am günstigsten richtig macht. Zuerst der Code der App: er ist schnell, kostet nichts und macht es jedes Mal gleich. Wo Urteil nötig ist, hilft die KI. Was nur du wissen kannst, fragt die App dich, einmal und in klaren Worten.

## Was der Code ohne KI tut

- Kontoauszüge im Format camt.053 lesen.
- Zahlen, die klar auf einem Beleg stehen.
- Doppelte Belege erkennen.
- Einen Beleg seiner Zahlung zuordnen, wenn Betrag und Nummer passen.
- Zahlungen nach deinen Regeln buchen, etwa «Swisscom immer auf Telefon».
- Die MWST-Abrechnung aus den Buchungen rechnen, und die Datei für die ESTV.

## Was die KI tut

- **Belege lesen.** Auch ein zerknittertes Foto: Betrag, Datum, Firma, und welche MWST der Beleg ausweist.
- **Belege und Zahlungen paaren,** wenn der Code keine eindeutige Zahlung findet.
- **Buchungen vorschlagen:** welches Konto, welcher MWST-Code. Jede Buchung sagt unter «Warum», woher sie kommt: welcher Beleg, welche Regel, welcher Lauf.
- **Kontoauszüge ohne camt.053 lesen,** aus einem PDF, Scan oder Foto. Die App prüft auf den Rappen, dass sie aufgehen.
- **Aus deinen Worten Regeln machen.** In der KI-Spalte (`⌘J`) sagst du, was du willst: «buch Swisscom immer auf Telefon», «frag mich bei Barbezügen über 500 Franken». Die KI macht daraus eine Regel, die die App ausführt. Eine Karte zeigt, welche Zahlungen sie trifft und wie sie sie buchen würde. Erst mit «Behalten» gilt sie.
- **Aus einer Korrektur lernen.** Änderst du Konto oder Code einer Buchung, fragt die App «Ins Wissen übernehmen?». «Vorschlag der KI» schlägt eine Regel vor. Die App nimmt sie nur, wenn sie diese Zahlung so bucht wie du.
- **Die Einrichtung im Gespräch,** statt mit einem Formular.

Ohne Beleg, der Schweizer MWST zeigt, zieht weder die App noch die KI Vorsteuer ab.

## Was immer du entscheidest

- Ob eine Zahlung privat war.
- Ob ein Verkauf MWST trug.
- Ob eine Regel gilt: «Behalten» auf ihrer Karte.
- Ob die Abrechnung eingereicht wird.
- Vorsteuer auf einem anderen Nachweis als einem Beleg. Das bucht nur ein Mensch, von Hand.

Was du korrigierst, merkt sich die App. Der nächste Lauf überschreibt es nicht. «Neu klassifizieren» auf einer Buchung, die du geprüft hast, warnt dich vorher.

## Welche KI

Die App fragt ein KI-Programm auf deinem Mac, über dein eigenes Abo:

- **Claude Code,** mit einem Abo Claude Pro oder höher.
- **Codex,** mit einem Abo ChatGPT Plus oder höher.

Eins davon reicht. Die Einrichtung beim ersten Start und Firma › KI › «KI-Programme auf diesem Mac» führen dich durch die Installation und die Anmeldung. Installiert wird mit dem offiziellen Installer des Anbieters, im Terminal, erst wenn du dort Enter drückst. Angemeldet wird im Browser, mit deinem Konto. Dein Login sieht die App nie.

Sind beide da, wählst du unter «Die App fragt», welches zuerst gefragt wird. Kann es nicht antworten, fragt die App das andere nur, wenn du das einschaltest.

Statt eines Abos geht auch ein API-Schlüssel von Anthropic oder OpenAI, unter «Erweitert: mit API-Schlüssel». Der Anbieter rechnet dann jeden Aufruf ab, auf deine Rechnung. Der Schlüssel liegt im Schlüsselbund dieses Macs, nie in der Buchhaltung. Ohne Claude Code oder Codex gehen zwei Dinge nicht: die KI-Spalte und «Im Terminal öffnen».

Unter «Modell pro Schritt» stellst du für jeden Schritt ein, welche KI ihn macht. Die Wahl gilt nur auf diesem Mac, nicht für andere, die dieselbe Buchhaltung öffnen.

## Ohne KI arbeiten

Alles, was die KI tut, kannst du auch von Hand. Die KI macht die Arbeit schneller, sie ist nie der einzige Weg.

**Keine KI eingerichtet.** Beim ersten Start wählst du «Ohne KI weiter». Die App fragt dann mit Knöpfen und Feldern, und sie merkt sich die Wahl auf diesem Mac. Wo eine KI fehlt, sagt die App es, etwa «Beleg lesen braucht eine KI. Auf diesem Mac ist keine eingerichtet.», mit «KI einrichten» und «Von Hand erfassen».

**KI ganz ausschalten.** Unter Firma › KI schaltet «KI ganz ausschalten» die KI auf diesem Mac ab, auch wenn eine eingerichtet ist. Dann fragt die App kein Modell mehr, nirgends. An den Büchern ändert das nichts. Jede Stelle sagt, dass die KI aus ist, und bietet ihren Weg von Hand an. Schaltest du sie wieder ein, kommt sofort dran, was auf sie gewartet hat.

So geht es ohne KI:

| Arbeit | Von Hand |
|---|---|
| Einen Beleg lesen | Der Beleg wartet und sagt es. Betrag, Datum und MWST trägst du im Beleg selbst ein. |
| Beleg und Zahlung paaren | «Zahlung verknüpfen» sucht nur nach Betrag, Datum und Name. |
| Eine Zahlung buchen | «Neu klassifizieren» bucht nach deinen Regeln, oder du buchst von Hand mit `N` in Buchungen. |
| Eine Regel machen | Firma › Regeln › «Neue Regel». Bei einer Korrektur führt «Selbst schreiben» ins selbe Formular. |
| Ein Kontoauszug als PDF | Saldi und Bewegungen abtippen, die CSV der Bank ablegen oder das PDF als Monatsauszug behalten. |
| Ein eigener Bericht | Bilanz & ER › Eigene Berichte › «Neuer Bericht». |

In eigenen Worten schreiben, in der KI-Spalte oder in der Einrichtung, geht erst wieder mit einer KI.

Wie die App bucht, steht unter [MWST-Codes erklärt](mwst-codes) und [Das Quartal](quartal). Wie viel die App auf einmal nimmt, steht unter [Grenzen der App](grenzen).
