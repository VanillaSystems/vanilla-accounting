# The share protocol, version 3

How Vanilla Accounting shares books through a service that keeps one file per share, sends the
invitation itself, and lets the browser download the file. Version 3 (2026-11-15,
the service's ADR 0004; in this repository [ADR 0016](adr/0016-sharing-books-end-to-end.md), «Amendment») replaces version 2's per-file objects: **a share is one
Freigabe-Datei** (`.vanillashare`), uploaded with one presigned PUT and downloaded with one presigned GET.
**The link is the access** (the service's ADR 0003). This file is written so that it can
be copied unchanged into the app's repository. `<domain>` is the publisher's domain; the service's
addresses are configuration, never constants in the app:

| Name | Example | What |
|---|---|---|
| Service | `https://share.<domain>` | the API under `/api/...`, and each share's page at `/<id>` |
| Confirmation address | `confirm@share.<domain>` | where the app sends the sender's confirmation e-mail |
| Mail sender | `no-reply@share.<domain>` | the From of the invitations the service sends (`MAIL_FROM`) |

## 1. The link

```
https://share.<domain>/<id>
```

`<id>` is the share's id: 26 characters `a-z2-7` (130 random bits), chosen by the service; nobody guesses
it. There is no `#` key, no code, no device binding: whoever has the link can download the file while the
share lives. Any other path is answered with 404. A fragment left from a version-1 link is ignored. The
page makes requests to its own origin only, sends no `Referer`, and is never redirected (`/` is a start
page, not a redirect).

The page shows who shares which books, her note and the deadline (the envelope, §3, as text), and:

- **«Herunterladen (196 MB)»**, the primary button (the size from the share's info). It asks the service
  for a download (`POST /api/shares/<id>/open`, §4.5) and navigates to the URL it gets: the browser
  downloads the file into Downloads with its own progress, and the page stays. Below it: «Danach die
  Freigabe-Datei doppelklicken; Vanilla Accounting öffnet sie.»
- **«In der App öffnen»**, secondary: `vanilla-accounting://open?share=<id>`. The app downloads the same
  file itself, with a visible progress window, saves it into Downloads and opens it.
- **The install help, the only one there is**, on demand («Vanilla Accounting noch nicht installiert?»), or
  when the page keeps focus 2.5 s after «In der App öffnen» (no app took the link): load the app (the latest
  release's dmg of `APP_REPO`, or `APP_DOWNLOAD_URL`), install it and open it once (while `APP_SIGNED` is
  false, macOS's «Dennoch öffnen» in Systemeinstellungen › Datenschutz & Sicherheit), then double-click the
  downloaded file. Not on a Mac, the page says the app is for the Mac.

The page shows no file of the share and unpacks nothing; it embeds no frame (`frame-src 'none'`) and stores
nothing in the browser (no localStorage, IndexedDB or Cache API).

## 2. The Freigabe-Datei

A share's file, each generation's, and a return's is the app's hand-over package: a zip, `.vanillashare`,
the whole books (a return: the recipient's changes). The app defines its content; inside it carries the
share's identity (the service, the share's id, the recipient's return token, the generation), so that the
file, double-clicked, opens as a copy linked to the share. In this app: `src/handover/package.ts`
(`share` in `index.json`, kept at a fixed size so the file's size is known before the service names the id
and the token: `writePackage`'s `indexRoom`), `src/share/transport.ts` (one PUT, one GET), and §8 below. The service checks only that it has the
declared size and starts like a zip (`PK\x03\x04`); it never reads more of it.

## 3. The envelope

`meta`, sent with a share, an update and a return, is a JSON object the service checks and keeps in its
database while the share lives:

```json
{ "v": 2, "senderName": "Anna Muster", "direction": "send", "company": "Muster Kaffee GmbH", "note": "Hoi Peter …", "asOf": "2026-11-14" }
```

`senderName` one line, 1 to 100 characters; `company` at most 200; `note` at most 1000 (line breaks kept);
`asOf` a day `YYYY-MM-DD`; `direction` `send` (a share, an update) or `return`. Other fields are dropped.
The page shows it as escaped text; the download's file name is made from it (§4.5).

## 4. Life of a share

1. **Confirm the sender, once per installation and address** (`POST /api/senders`). The service
   answers with a device token and an e-mail to send: to the confirmation address, subject
   `Vanilla Accounting confirmation <code>` (ASCII; an RFC 2047-encoded subject is decoded too). The app
   sends it from the person's own mail account. The service accepts it only with exactly one From
   address, the registered one, and when the topmost `Authentication-Results` header is Cloudflare's
   (`mx.cloudflare.net`, the only one claiming it) and shows DMARC pass for that From domain, or DKIM or
   SPF pass for a domain aligned with it. The app polls `GET /api/senders/me` until `confirmed`. Since
   the service sends mail in the sharer's name, this confirmation is also what keeps it from mailing for
   strangers.
2. **Create** (`POST /api/shares`, device token): the file's exact size in bytes and the envelope. The
   service answers with the id, the **revoke token** (the sharer's, for the upload, status, updates,
   invitations and withdrawal), the **return token** (for the recipient, §5) and the share's URL. A body
   with `key`, `objects` or `openProof` comes from an app of version 1 or 2: refused `426 appTooOld`.
3. **Upload**: `POST /api/shares/<id>/upload` returns one target; the app PUTs the file there, straight to
   storage, with the headers given. The URL is valid 10 minutes and signs the declared size and
   `If-None-Match: *`: it writes the file once and never overwrites. Asking again gives a new URL (a
   retry). Then `POST /api/shares/<id>/complete`: the service checks that the file arrived with its exact
   size and starts like a zip. Files live under `shares/<id>/g<generation>/package.vanillashare`.
4. **Invite** (`POST /api/shares/<id>/invite`, revoke token). The service sends the invitation itself,
   through Resend: From `"<sender> über Vanilla Accounting" <MAIL_FROM>` (fr/en «via», it «tramite»),
   Reply-To the sharer's confirmed address, to the recipient. Only the share's confirmed sender address
   may be the sender (`403 notSender`). The mail is the service's own template (`src/email/invitation.ts`)
   in de, fr, it or en: the client supplies only the names, the company, a message and the language, so
   nobody can put other words in the service's mouth. It is short and plain: who shares which books,
   the sender's message, escaped and marked as hers («Nachricht von …:», at most 2000 characters), one
   button «Buchhaltung öffnen» linking `https://share.<domain>/<id>`, the end date in words, and that
   replies go to the sender. **No download link and no install steps**: the share page carries them
   (§1). No image, no remote resource, no tracking. The first call keeps `{to, from, message, company,
   language}` on the share while it lives; «Nochmals senden» sends `{}` (or fields that replace the kept
   ones). At most 10 e-mails per share (invitations and update notices together) and 100 per day for the
   whole service (Resend's account limit). Without the service's mail key the app offers «Link kopieren»
   (`503 mailOff`).
5. **Open** (`POST /api/shares/<id>/open`, body `{"v": 3}`) needs nothing but the id. Without the
   protocol marker (0.6.1 and older send `{}`) the service answers `appTooOld` 426 and counts no opening,
   so an older app says «bitte aktualisieren» instead of «Link beschädigt». It records an opening and
   returns a **download**: a presigned GET at the storage, which must be used within 60 seconds (the download itself
   may take as long as it needs), answered with `Content-Type: application/octet-stream` and
   `Content-Disposition: attachment; filename="<ASCII name>"; filename*=UTF-8''<name>`. The name is
   `<Firma> – Buchhaltung (<Datum>).vanillashare` (without a company `Buchhaltung (<Datum>).vanillashare`;
   a return `<Firma> – Änderungen von <Name> (<Datum>).vanillashare`), the date the envelope's `asOf`, else
   the day of the generation. The service never reads the file for a download. **Openings are not
   limited**: each one is recorded for the sharer's status («geöffnet am …»), and the share stays open
   until its end. Only the service's daily guardrail (2,000 openings a day in total) and its month's R2
   reads can refuse one.
6. **Watch**: `GET /api/shares/<id>/status` (revoke token): state, generation, each opening's time, the
   invitation's count and times (no address), returns. The app asks at most every `pollAfterSeconds` (900).
7. **Update** («Aktualisieren», `POST /api/shares/<id>/update`, revoke token): the whole books again, as a
   new file, into the same share: same id, same link, same tokens, the invitation kept. The service keeps
   serving the current generation while the next one is uploaded (`upload`, the PUT and `complete` act on
   the pending generation; info and open on the current one). `complete` swaps it in at once: the new
   size and envelope, `updatedAt`, and **the 14 days start again**; the previous generation's file is
   deleted, and a download URL of it no longer works: the next opening downloads the new one. A second
   update while one is pending abandons the first (its file is deleted). At most 20 updates per share; each
   counts toward the sender's 10 shares a day. The notice to the recipient is `invite` with `kind:
   "update"`: «{sender} hat die Buchhaltung aktualisiert».
8. **End**: **14 days** after the upload (or the latest update) completed, or at once by «Zurückziehen»
   (`DELETE /api/shares/<id>`), the service deletes the file, the envelope and the kept invitation. A file
   already downloaded stays where it was downloaded; nothing can recall it. The row stays 30 days without
   them, so the page can say «abgelaufen» or «zurückgezogen»; after that the id is unknown (`404`). An app
   treats both as «zurückgezogen / nicht mehr da».

**Shares of version 1 and 2** (the 0.6.0 and 0.6.1 apps: per-file sealed objects) cannot be downloaded as
one file. The migration `0004_one_package.sql` marks every one still uploading or ready as ended at once;
their links say «abgelaufen», the hourly cleanup deletes their objects, and the sharer shares again with
the new app (or as a `.vanillashare` file by hand).

## 5. The return

The recipient sends his changes back into the same share, without a confirmation of his own:

1. `POST /api/shares/<id>/returns` with the return token from the file, the return file's size and an
   envelope with `direction: "return"` (not while the share is still uploading). The return is a share of
   its own (its own id and revoke token) uploaded like any other: one file. It counts toward the sharer's
   10 shares a day and the share's 5 returns.
2. The sharer's status lists the return; her app downloads it with her revoke token
   (`POST /api/shares/<returnId>/open`). Nobody else can open a return, and its page info names nothing.
   Returns live 14 days after their upload; they are accepted for 30 days after the share's newest state,
   at most 200 MiB each. «Zurückziehen» ends them with the share and refuses new ones. A share that merely
   expired keeps its returns: they live their own 14 days, since the recipient may still send back after
   the share's 14 days.

## 6. What the service sees

The service can read a share while it lives: the file is stored as the app made it. R2 encrypts it at rest
under Cloudflare's keys, so a disk alone reveals nothing, but the operator and Cloudflare could read a live
share. Nothing in the service's code reads more of a file than its first four bytes, and nothing of it is
logged, but that is a promise of the operator, not a property of the protocol. The link is the access:
whoever has it can download the file while the share lives. What the design guarantees: the file and every
fact about people are deleted at the end; download URLs live minutes; the logs carry neither a token, an
address nor a name.

| Sees, while the share lives | Never keeps |
|---|---|
| the file (the books), in R2, encrypted at rest under Cloudflare's keys | the file after the share ended |
| the envelope: the sender's name, the company, her note, the date | any of it after the share ended |
| the invitation: recipient's and sender's name and address, the message, the company | any of it after the share ended |
| a keyed hash of the confirmed sender address | the address itself, outside an invitation |
| the file's size, generations | file names inside the package (it never opens it) |
| times of creation, upload, update, each opening, each e-mail, withdrawal | |
| a keyed hash of the uploading IP, for a day | |

Resend, which delivers the invitation, sees the mail as sent (sender and recipient names and addresses,
the message, the link) and keeps it as its terms say. The hashes are HMAC-SHA-256 under `HASH_SECRET`;
they let the service count shares per sender and per IP. A downloaded file is a normal Freigabe-Datei: it
is as private as the computer it lies on.

## 7. Errors

Every refusal is JSON `{ "error": "<German words for a person>", "code": "<stable code>", ... }`. A limit
names itself: `limit`, and `per` (`sender-day`, `ip-day`, `share`, `day`, `month`) where it counts. The codes are
listed in the service's `docs/api.md`.

## 8. In the app: the Freigabe-Datei is the recipient's document

The owner's decision of 2026-11-15 («the share file is the document»; `src/handover/document.ts`):

- A Freigabe-Datei the recipient opens (downloaded by the page, by «In der App öffnen», mailed, any way)
  is his copy. The app works on a copy of the books in its own folder, but that copy is only a cache: his
  changes are saved **into the file**, as one more zip member, `return.vanillashare`, the return package
  «Zurückschicken» would send; the hand-over's own members stay as they came, so the file still proves its
  version. The window's title names the file, «ungespeichert» while his changes are not all in it.
- «Sichern» (⌘S) writes the file beside it and renames it over the old one, so a crash leaves the old file
  whole (a `.<name>.saving-<pid>` left by a crash goes the next time the file is opened or saved). The
  hand-over's members are copied as they are, in chunks, never packed again, so a large copy saves without
  holding the app. Once he saved into a file himself, the app also saves by itself when he has been idle a
  while, when the window closes and when the app quits (⌘Q, SIGTERM: the quit waits for that save, at most
  35 seconds) (before, macOS may ask about the file's folder, which the app does only when he asked). A file
  that moved, went or cannot be written is said, with «Sichern unter…».
- The app writes over the file at the document's path only when it is the file the app last wrote or
  opened there, untouched since, or a hand-over of the copy's very version and share. Anything else put
  there (a newer state, another share's file) stays as it is: the bar says «andere Datei am Ort», the app
  saves there by itself no more, and «Sichern unter…» writes a new file (`shareDocOther`).
- Opened on another Mac, the file brings his changes along. Opened again where the copy is, it never takes
  back a change he made in the copy after saving the file: changes the copy holds already, or records he
  changed since, keep the copy's version. A newer file (after «Aktualisieren») opened
  over a copy with his changes carries them over, says so, and becomes the copy's document; the older
  file stays as it was. A newer state that comes without its file (his copy asking its share when it opens,
  a file dropped in the browser) moves the copy forward and leaves his file where it is: nothing lands in
  Downloads unasked, and his file holds the older state («ungespeichert») until he, or the app by itself,
  saves the new state into it. Changes in a period filed meanwhile are dropped, said, and the seals stay whole.
- Sending back: he mails the file (any transfer), or «An <Name> zurückschicken» sends only the return
  through the share. The sharer's app knows a mailed-back file by its version (one her books wrote, of her
  firm) and shows his changes for review, never a copy of her own books; her own file without his changes
  is refused in words (`shareOwnBooks`).
- A file naming a share of another service than this app's opens as a plain file: its return goes back as
  a file.
- `.vanillashare` is the only extension the app writes; the `.vanilla` share zips of 0.6.x still open
  (known by their content, a zip with `index.json`).
