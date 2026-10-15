# The built UI against the mockup (15.10.2026)

The mockup is `docs/0.4.0/mockups/workflows.html` (9 screens). The built app was compared screen by
screen on a copy of real books (1440 px wide, German and English). Each gap closes with the same
check: the screen beside the mockup's, both screenshots in the commit's verification.

Known deliberate departures: the areas sit in a bar down the left edge (owner's wish, 15.10.), not
in the dock at the bottom; the mockup's «Leiste unten» switch therefore has no counterpart.

Order: what the owner hit first, then what every screen shares, then screen by screen.

## Screen 3 · Ein Lauf (a run)

The owner's verdict: "it tells me which steps ran at what time, but not what the run did."

| Mockup | Built |
|---|---|
| Title in words: «Lauf 1047 · FedEx Express 412.35», the item it ran for | «Lauf receipt-intake-0c20062f» |
| Under it: started when, by what («durch Knopf «Buchen»»), the item, where the AI decided | status chip and a timestamp |
| Per step: **LIEST** (its input) and **ERGEBNIS** (its output, in words: «transaction: BT-2026-10-14-03, CHF 412.35 · rate: CHF, kein Kurs nötig»), the step's folder and file | step name → outcome, «books.write geschrieben», «1 KI-Antwort» |
| What it wrote, as the books' records (entries, receipts), each a link | an effect name |
| The run strip (latest runs as dots) and Starten ▾ | none |
| Waiting: a yellow box «Wartet auf dich bei … seit 2 Std.», the reason, and the decision as a button | (to check with a waiting run) |
| «Mit Änderung abspielen», «Ablauf ändern…», «Als Testfall behalten» | «Nochmals abspielen», «Mit KI ändern …» |
| The graph marks the path taken (✓ per step) | path drawn |

## Shared by every screen

| Mockup | Built |
|---|---|
| Status top right: spinner with «2 laufen», amber dot with a count when something waits; a click opens a live panel (running with bars, queued, waiting, finished last; «Warteschlange öffnen», «Aufgaben») | the corner shows only while runs run |
| Top bar: company, search, **period**, zoom, export, theme, language, AI, pin; folded a pill «Beispiel GmbH · 2026-Q4 ▾» | the period is missing in Automatisierung and Änderungen; the bar covers the page's heading |
| Area headings with period and counts: «Automatisierung 2026-Q4 · 9 Abläufe · 12 Läufe · 4 offen» | heading only |
| AI sidebar composer: context as chips («Ansicht: …»), @ mentions, mode «Ändern / Nur fragen», model «Auto», where it runs | to compare |

## Screen 1 · Automatisierung

| Mockup | Built |
|---|---|
| Warteschlange as a card on top: «2 laufen · 4 in der Schlange · 6 fertig» | rows «Process map · Queue · Tasks» |
| Groups numbered: «1 · Sammeln», «2 · Zuordnen und buchen», «3 · Quartal abschliessen» | not numbered |
| Each workflow: its triggers as chips (Zeitplan, Belege holen, Von aussen, Ereignis, Buchen), «2 offen» badge | a cadence text or «not runnable yet» |
| Header: `workflows/booking/`, run strip, **Starten ▾**, «Ändern…», «KI entscheidet in 2 Schritten mit» | title, description, «Change with AI…» |
| Tabs with counts: «Auslöser 2 · Läufe 9» | no counts |
| Graph starts at the triggers (button pill blue, event pill black), legend under it, «Schritt anklicken für Details» | starts at the first step, no legend |

## Screen 2 · Prozesskarte

| Mockup | Built |
|---|---|
| A sentence under the title: «Die Buchhaltung eines Jahres in vier Phasen …» | none |
| Phases numbered, each with its cadence in words («jeden Tag, sobald etwas ankommt») and a state chip («läuft», «1 Lauf steckt», «Q3 fällig 30.11.») | phase name only |
| Cards with «STARTET BEI» and «MELDET» (events), state («2 steckt»), arrows between cards | name and cadence; crossed-out «→ …» lines |
| «Jahr abschliessen» loops back: «eröffnet das neue Jahr: zurück zu 1» | none |

## Screen 4 · Auslöser in anderen Bereichen

| Mockup | Built |
|---|---|
| A workflow's button on the object (Bewegung: «Buchen», «Beleg zuordnen») with «kommt aus workflows/booking/workflow.yaml» | to check per area |
| «Ein Lauf steckt für diese Bewegung. Lauf 1047 öffnen» on the object | to check |
| Every entry an AI booked: «von KI gebucht · Warum so gebucht? Lauf 1046 · Schritt … · Regel …» | to check in Buchungen |
| MWST: «Abrechnung erstellen» on the quarter | built (a button in the VAT list head) |

## Screen 5 · Wenn ein Ablauf dich braucht (Aufgaben)

| Mockup | Built |
|---|---|
| «Aufgaben für dich · 2 offen · sortiert nach Frist», grouped Heute / Bald | «Tasks», a flat list |
| A task card: what, why, numbered steps, buttons («Anmeldefenster öffnen», «Fertig, weiter», «Diesmal überspringen», «Quelle pausieren…»), deadline and reminders | to compare with a waiting run |
| The run's sources as a table: per source state (fertig, wartet auf dich, versucht es wieder), what it got, session «gültig bis …» | none |
| «Bald»: a session about to expire («Shopify-Sitzung erneuern · in 3 Tagen») | none |
| How it tells you: the Mac notification, shown | none |

## Screen 6 · Ablauf ändern

| Mockup | Built |
|---|---|
| A page «Ändern · Buchen»: three ways (with the AI here, directly without AI, with Claude Code or Codex), «Das Tor für alle drei» | the AI sidebar opens |
| Without AI: «Zeitplan ändern…», «Ablauf pausieren», «Regel bearbeiten…» | schedule editor exists; to place here |
| Composer with examples («Belege erst um 07:00 sammeln» …) and «Entwurf machen» | the sidebar's composer |

## Screen 7 · Änderungen

| Mockup | Built |
|---|---|
| Left: «synchron · zuletzt heute 11:40», Verlauf with who and when | to compare on a repository (the sandbox copy has none) |
| Right: «Seit dem letzten Speichern», BÜCHER · AUS LÄUFEN (per run, entries) and WIE DIE APP ARBEITET · DATEIEN (+/− per file), «Speichern vorbereiten» | to compare |

## Screen 8 · Dateien ablegen

| Mockup | Built |
|---|---|
| Title «9 Dateien hinzufügen · Erkannt und noch nicht übernommen. Ändere, was nicht stimmt.» | «Dateien hinzufügen» |
| Rows: an icon per kind, the facts read (Coop Pronto · 14.10.2026 · CHF 23.80), KI/STRUKTUR/HINWEISE tag, «→ Beleg aufnehmen» naming the workflow, «erkannt» chip, «Ändern» | name, kind, a chip |
| Footer: «4 werden übernommen · 3 brauchen dich · 2 nicht übernommen», «Hinzufügen (4, 3 warten im Eingang)» | a sum and «Hinzufügen (n)» |
| After «Hinzufügen»: «Wird verarbeitet», overall bar, each row its bar and step, «Im Hintergrund weiter», a chip in the title bar «Import läuft · 62 %»; how each file ends (gebucht, wartet, braucht dich) | **in progress (15.10.)**: title, overall bar, per file where it is, «Im Hintergrund weiter»; the title-bar chip is missing |

## Screen 9 · Warteschlange

| Mockup | Built |
|---|---|
| «alle Abläufe · gleichzeitig höchstens 2 KI-Schritte und 4 andere», «Pausieren» | «Pause» |
| Läuft: per run the item, the workflow chip, a bar and «26/41 · Bewegungen zugeordnet» | to compare with runs |
| In der Schlange: order, why it waits («dahinter», «ohne KI: startet, sobald …», «Zeitplan: morgen 06:00»), × | to compare |
| Geparkt: «warten auf dich» with links, «Belege warten auf ihre Bewegung» | to compare |
| Fertig: icons as the run strip, time and duration | to compare |
| Empty: — | «The queue fills once the app starts runs on its own.» |
