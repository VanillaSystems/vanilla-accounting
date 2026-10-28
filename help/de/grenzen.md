---
title: Grenzen der App
summary: Wie viele Dateien, Seiten und Zeilen die App auf einmal nimmt, und was sie sagt, wenn es mehr sind.
section: nachschlagen
order: 4
---
Wo die App eine Grenze hat, sagt sie es dir, sobald du sie erreichst: welche Grenze es ist und was sie ausgelassen hat. Sie schneidet nie still ab. Die Zahlen hier sind dieselben, mit denen die App rechnet.

| Was | Höchstens | Was die App dann tut |
|---|---|---|
| Dateien, die du auf einmal auf eine Seite ziehst | {{files-per-drop}} | Sie nimmt die ersten und nennt, wie viele nicht dazukamen. Den Ordner in kleineren Teilen ablegen. |
| Dateien an die KI in einer Nachricht | {{files-per-message}} | Sie schickt die ersten und nennt, wie viele nicht mitgingen. |
| Grösse einer Datei an die KI | {{attachment-mb}} MB | Sie nimmt die Datei nicht an. |
| Zeilen oder Belege, die du auf einmal auswählst | {{selection-max}} | Sie wählt die ersten aus und nennt die ausgelassenen. |
| Zeilen einer CSV-Datei der Bank | {{csv-rows}} | Sie liest nichts davon und sagt es. Einen kürzeren Zeitraum exportieren. |
| Seiten eines Kontoauszugs als PDF, die die KI liest | {{statement-pages}} | Der Auszug wird eine Tabelle zum Ausfüllen, oder du legst die CSV der Bank ab. |
| Seiten eines Belegs, die die KI ansieht | {{receipt-pages}} | Die ersten Seiten: dort stehen Betrag, Datum und MWST. |
| ZIP-Dateien ineinander | {{zip-depth}} Ebenen | Sie packt die ZIP-Datei nicht aus und sagt es. |
| Was eine Ablage ausgepackt ergeben darf | {{zip-mb}} MB | Sie packt die ZIP-Datei nicht aus und sagt es. |
