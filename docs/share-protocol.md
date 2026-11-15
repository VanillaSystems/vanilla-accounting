# The share protocol, version 2

How Vanilla Accounting shares books through a service that stores only ciphertext and sends the
invitation itself. Version 2 (2026-11-15, the service's ADR 0003; in this repository [ADR 0016](adr/0016-sharing-books-end-to-end.md), «Amendment») replaces version 1's
end-to-end design: **the link is the access.** The app still seals every object under a per-share key,
so the storage holds only ciphertext; the service keeps that key, wrapped, and hands it to whoever has
the link. This file is written so that it can be copied unchanged into the app's repository. `<domain>`
is the publisher's domain; the service's addresses are configuration, never constants in the app:

| Name | Example | What |
|---|---|---|
| Service | `https://share.<domain>` | the API under `/api/...`, and each share's page at `/<id>` |
| Confirmation address | `confirm@share.<domain>` | where the app sends the sender's confirmation e-mail |
| Mail sender | `no-reply@share.<domain>` | the From of the invitations the service sends (`MAIL_FROM`) |

The reference implementation of the format is `src/crypto/` (TypeScript, WebCrypto only: Node 20+,
browsers, Workers). Both copies, the app's and the service's, pass the vectors in
`test-vectors/share-v1.json`, which an independent implementation (`node:crypto`,
`scripts/make-test-vectors.mjs`) wrote. The format of a sealed blob (§2) and of the package (§3) did not
change in version 2; its header still says version 1. The vectors' `openProof` and `wrapKey` belong to
protocol version 1 and are no longer used by the service.

## 1. Keys and the link

- A share has a **share key**: 32 random bytes from a cryptographically secure generator, new for
  every share and for every **generation** of it (§4, «Aktualisieren»). Never reused, never derived from
  a password. The app seals every object under it (§2) before the upload.
- **Key custody.** The app sends the key with the share (`key`, base64url without padding, 43
  characters). The service stores it only wrapped:
  `AES-256-GCM(KEK, iv = 12 random bytes, aad = the share's id, key)`, kept as
  `base64url(iv ‖ ciphertext ‖ tag)`, where
  `KEK = HKDF-SHA-256(ikm = the bytes of HASH_SECRET, salt = empty, info = "vanilla-share/v2/key-wrap", 32 bytes)`.
  A return's key is wrapped the same way, bound to the return's id. The database alone reveals no key;
  the database together with `HASH_SECRET` does (§6). The wrapped key is dropped when the share ends.
- **The link is the access:**

  ```
  https://share.<domain>/<id>
  ```

  `<id>` is the share's id: 26 characters `a-z2-7` (130 random bits), chosen by the service; nobody
  guesses it. There is no `#` key, no code, no device binding: whoever has the link gets the key from
  the service (`GET /api/shares/<id>` while the share is ready, and with every opening). Any other path
  is answered with 404. A fragment left from a version-1 link is ignored. The page makes requests to its
  own origin only, sends no `Referer`, and is never redirected (`/` is a start page, not a redirect).
- **The page only fetches and decrypts.** Everything that renders a file of the share (the read-only
  viewer, receipt previews, PDFs drawn with pdf.js) runs in `<iframe sandbox="allow-scripts
  allow-downloads">` **without** `allow-same-origin`, served with its own `Content-Security-Policy:
  sandbox allow-scripts allow-downloads; default-src 'none'; connect-src 'none' …`. Its origin is opaque:
  it cannot reach the page's origin, its storage, the key, or another share, and it makes no request. On
  the frame's first load the page sends it one end of a `MessageChannel` (the viewer accepts that once,
  from its parent and the page's origin); all files and requests then go over that port only. A second
  load of the frame removes it. Files larger than 50 MB are not fetched for the browser view; the page
  says so. Neither side stores a key or plaintext (no localStorage, IndexedDB or Cache API).
- The Mac app is opened from the page with `vanilla-accounting://open?share=<id>`; it asks the service
  for the key itself.

## 2. A sealed blob

Every object the service stores is one sealed blob:

```
blob   = header (40 bytes) || chunk_0 || … || chunk_{n-1}
header = magic "VSHR" (4) | version 1 (1) | kind (1) | 0x0000 (2)
       | chunkSize (u32 BE) | plaintextLength (u64 BE) | chunkCount (u32 BE) | salt (16)
```

| Field | Value |
|---|---|
| kind | 2 `meta`, 3 `index`, 4 `file`, 5 `wrap` |
| chunkSize | plaintext bytes per chunk, 64 … 16 MiB; default 1 MiB |
| plaintextLength | ≤ 2^53 − 1 |
| chunkCount | `max(1, ceil(plaintextLength / chunkSize))`; an empty plaintext is one empty chunk |
| salt | 16 random bytes, new for every blob |

**Content key.** `HKDF-SHA-256(ikm = share key, salt = header.salt, info = "vanilla-share/v1/<kind>/<name>", 32 bytes)`,
used as an AES-256-GCM key. `<name>` is the blob's **object name** in the share: `index`, `meta`,
`wrap`, or the file's object id. A blob stored under another name, or read as another kind, fails.

**Chunks.** Chunk `i` holds `chunkSize` plaintext bytes, the last one the rest. It is
`AES-256-GCM(contentKey, nonce_i, aad = the 40 header bytes, plaintext_i)`, ciphertext followed by its
16-byte tag. The nonce is 12 bytes: 7 zero bytes, `i` as u32 BE, and a final byte that is 1 for the
last chunk and 0 otherwise (the STREAM construction).

What this detects, each proven by a test in `tests/crypto/`:

- a changed byte anywhere (header, chunk, tag): authentication fails;
- chunks reordered, duplicated or replaced by another blob's: the index or the key differs, so the tag fails;
- a blob cut at a chunk boundary: the header's length says more is due (`truncated`); a header rewritten
  to a shorter length fails because the header is the additional data of every chunk;
- bytes after the last chunk: refused (`trailing`);
- a blob of one kind read as another, or stored under another object name: refused or fails.

The blob's size is `40 + plaintextLength + 16 × chunkCount`. A reader that streams a blob releases each
chunk's plaintext only after its tag checked out, and must discard everything unless the stream ends
without an error (write to a temporary file, rename on success).

## 3. The package

A share is a set of objects, each a sealed blob:

| Object name | Kind | What |
|---|---|---|
| `index` | index | the encrypted index (one per share) |
| `<object id>` | file | one file each; the id is 26 random characters `a-z2-7` the app chooses |

The **index** is JSON. The format checks `format`, `kind` and `files`; the app defines the rest
(spec B3.4: the company's name and UID, sharer and recipient, version and checksum, `base`, `omitted`,
the git tree objects, `basedOn` for a return, and the **return token**, §5):

```json
{
  "format": 1,
  "kind": "full",
  "files": [
    { "path": "ledger.json", "object": "k3n…", "bytes": 1832, "sha256": "9f2c…" },
    { "path": "transactional-data/2026/receipts/coop.pdf", "object": "a7q…", "bytes": 28104, "sha256": "…" }
  ]
}
```

- `path` is relative with `/`, without `.`, `..`, empty segments, a drive or a backslash; a reader
  refuses any other (`checkPath`).
- `bytes` and `sha256` are the plaintext's; a reader checks both after decrypting (`decryptFile`).
- Each path and each object appears once.

The service stores object ids and sizes in the clear; paths and names are only inside the sealed index (§6 says who could read it). A reader fetches the index, then
only the files it shows: the browser view loads a receipt when a person opens it.

**The envelope** (`meta`, optional, at most 8192 characters base64url) is one small blob the service
keeps in its database for the page: `{ v: 1, senderName, direction: "send" | "return", company?, note?, asOf? }`.
The page decrypts it with the key from the share's info to say who shares what before an opening.

## 4. Life of a share

1. **Confirm the sender, once per installation and address** (`POST /api/senders`). The service
   answers with a device token and an e-mail to send: to the confirmation address, subject
   `Vanilla Accounting confirmation <code>` (ASCII; an RFC 2047-encoded subject is decoded too). The app
   sends it from the person's own mail account. The service accepts it only with exactly one From
   address, the registered one, and when the topmost `Authentication-Results` header is Cloudflare's
   (`mx.cloudflare.net`, the only one claiming it) and shows DMARC pass for that From domain, or DKIM or
   SPF pass for a domain aligned with it. The app polls `GET /api/senders/me` until `confirmed`. Now that
   the service sends mail in the sharer's name, this confirmation is also what keeps it from mailing for
   strangers.
2. **Create** (`POST /api/shares`, device token): total ciphertext bytes, number of objects, the
   envelope, the share key. The service answers with the id, the **revoke token** (the sharer's, for
   status, updates, invitations and withdrawal), the **return token** (for the recipient, §5) and the
   share's URL. A body without `key` comes from a version-1 app: refused `426 appTooOld`.
3. **Upload**: `POST /api/shares/<id>/uploads` names up to 100 objects with their exact sizes and
   returns a URL per object; the app PUTs each blob there, straight to storage, with the headers given.
   A URL is valid 10 minutes and signs the size and `If-None-Match: *`: it writes its object once and
   never overwrites. An object keeps the size it was first declared with (asking again with the same
   size is a retry; another size is refused). Then `POST /api/shares/<id>/complete`: the service checks
   that every declared object arrived with its exact size and that `index` has an index header. Objects
   live under `shares/<id>/g<generation>/<name>`.
4. **Invite** (`POST /api/shares/<id>/invite`, revoke token). The service sends the invitation itself,
   through Resend: From `"<sender> über Vanilla Accounting" <MAIL_FROM>` (fr/en «via», it «tramite»),
   Reply-To the sharer's confirmed address, to the recipient. Only the share's confirmed sender address
   may be the sender (`403 notSender`). The mail is the service's own template (`src/email/invitation.ts`)
   in de, fr, it or en: the client supplies only the names, the company, a message and the language, so
   nobody can put other words in the service's mouth. It carries the steps (download the app from
   `APP_DOWNLOAD_URL`, macOS's «Dennoch öffnen», the button, the return), the button linking
   `https://share.<domain>/<id>`, the end date in words, and the sender's message, escaped and marked as
   hers («Nachricht von …:», at most 2000 characters). No image, no remote resource, no tracking. The
   first call keeps `{to, from, message, company, language}` on the share while it lives; «Nochmals
   senden» sends `{}` (or fields that replace the kept ones, but never another recipient address once an
   e-mail went out: `recipientFixed`). At most 10 e-mails per share (invitations and update notices
   together), 20 per sender address and day over all her shares (`tooManyMails`), and 100 per day for the
   whole service (Resend's account limit). Without
   the service's mail key the app offers «Link kopieren» (`503 mailOff`).
5. **Open**: `POST /api/shares/<id>/open` needs nothing but the id. It returns the key, the index's URL
   (readable twice per opening, for a retry) and a ticket; `POST /api/shares/<id>/urls` (the ticket)
   turns the ticket into URLs for files, never for the index. Every read goes through the service's own
   origin (`/api/shares/<id>/objects/<name>?ticket=…`, `Range` allowed), so the page's CSP holds and
   every read is counted; no read URL points at the storage. **Openings are not limited**: each one is
   recorded for the sharer's status, and the share stays open until its end. Only the service's daily
   guardrail (2,000 openings a day in total) can refuse one.
6. **Watch**: `GET /api/shares/<id>/status` (revoke token): state, generation, each opening's time, the
   invitation's count and times (no address), returns. The app asks at most every `pollAfterSeconds` (900).
7. **Update** («Aktualisieren», `POST /api/shares/<id>/update`, revoke token): the whole books again,
   under a fresh key, into the same share: same id, same link, same tokens, the invitation kept. The
   service keeps serving the current generation while the next one is uploaded (`uploads`, the PUTs and
   `complete` act on the pending generation; info, open, urls and reads on the current one). `complete`
   swaps it in at once: the new key, sizes and envelope, `updatedAt`, and **the 14 days start again**;
   the previous generation's objects are deleted. A ticket names its generation, so a reader of the old
   one is told `ticketExpired` and opens again. A second update while one is pending abandons the first
   (its objects are deleted). At most 20 updates per share; each counts toward the sender's 10 shares a
   day. The notice to the recipient is `invite` with `kind: "update"`: «{sender} hat die Buchhaltung
   aktualisiert»; an app that already opened the share fetches the new state by itself.
8. **End**: **14 days** after the upload (or the latest update) completed, or at once by
   «Zurückziehen» (`DELETE /api/shares/<id>`), the service deletes every object, the wrapped key and the
   kept invitation, and «Zurückziehen» ends the share's returns the same way. A copy already opened stays where it was opened; nothing can recall it. The row
   stays 30 days without them, so the page can say «abgelaufen» or «zurückgezogen»; after that the id
   is unknown (`404`). An app treats both as «zurückgezogen / nicht mehr da».

**Shares of version 1** (the 0.6.0 app, key only in the link's `#`) cannot be opened by version 2,
which holds no key for them. The migration `0003_link_is_access.sql` marks every one still uploading or
ready as ended at once; their links say «abgelaufen», the hourly cleanup deletes their objects, and the
sharer shares again with the new app (or as a `.vanilla` file).

## 5. The return

The recipient sends his changes back into the same share, without a confirmation of his own:

1. His app makes a new **return key**.
2. `POST /api/shares/<id>/returns` with the return token from the index, the sizes and the return key
   (not while the share is still uploading). The return is a share of its own (its own id and revoke
   token) uploaded like any other, its index of kind `return`, sealed under the return key; the service
   keeps that key wrapped, bound to the return's id. It counts toward the sharer's 10 shares a day and
   the share's 5 returns. `complete` needs no wrapped key (one sent is ignored).
3. The sharer's status lists the return; her app opens it with her revoke token
   (`POST /api/shares/<returnId>/open`) and gets the return key with the ticket. Nobody else can open a
   return, and its page info hands out no key. Returns live 14 days after their upload; they are accepted
   for 30 days after the share's newest state, at most 200 MB each, and refused (and the ones there
   deleted) after «Zurückziehen». The sharer's app fetches a return of up to 25 MB when it checks its
   shares; a larger one waits at the service until she fetches it («Holen»).

**Which copy a link moves.** A link moves the copy that came by the same share («Aktualisieren»)
without a question. Any confirmed sender can name any firm and any sender in a package, so a link
whose package would move a copy that came by another link, or from another sender, moves nothing by
itself: the app names who the copy came from and who the link claims to be from, and offers «Als
neue Kopie öffnen» (recommended: a second copy beside it, the first one and its link kept) and
«Bestehende Kopie ersetzen» (the copy follows this link, his changes kept, his return then goes to
it). A `.vanilla` file in that place opens as a new copy.

## 6. What the service sees

The service can read a share while it lives. It holds the wrapped key and `HASH_SECRET`; with both, its
operator could unwrap the key and decrypt the books. It does not do so, nothing in its code does, and
nothing of it is logged, but that is a promise of the operator, not a property of the protocol. What
the design still guarantees: the storage (R2) and a copy of the database alone hold only ciphertext and
wrapped keys; everything is deleted at the end; and the logs carry neither a key, a token, an address nor
a name.

| Sees, while the share lives | Never keeps |
|---|---|
| the share key, wrapped under a key derived from `HASH_SECRET` | the key unwrapped, in a log or anywhere else |
| the invitation: recipient's and sender's name and address, the message, the company | any of it after the share ended |
| a keyed hash of the confirmed sender address | the address itself, outside an invitation |
| sizes and number of objects, object ids, generations | paths and file names (they are inside the sealed index) |
| times of creation, upload, update, each opening, each e-mail, withdrawal | |
| a keyed hash of the uploading IP, for a day | |
| the envelope, as ciphertext | |

Resend, which delivers the invitation, sees the mail as sent (sender and recipient names and addresses,
the message, the link) and keeps it as its terms say. The hashes are HMAC-SHA-256 under `HASH_SECRET`;
they let the service count shares per sender and per IP.

## 7. Errors

Every refusal is JSON `{ "error": "<German words for a person>", "code": "<stable code>", ... }`. A limit
names itself: `limit`, and `per` (`sender-day`, `ip-day`, `share`, `day`, `month`) where it counts. The codes are
listed in the service's `docs/api.md`.
