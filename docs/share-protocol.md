# The share protocol, version 1

> Copied from the share service's `docs/protocol.md` (one example size shortened for the leak guard). In this repository the reference
> implementation is `src/share/crypto/` (a byte-for-byte copy of the service's `src/crypto/`), the
> vectors are `tests/fixtures/share/share-v1.json` (tests/share-crypto.test.ts), the invitation is
> `src/share/invitation.ts`, and the app's side of the API is `src/share/client.ts`.

How Vanilla Accounting shares books end to end through a service that cannot read them. This file is
written so that it can be copied unchanged into the app's repository. `<domain>` is the publisher's
domain; the service's addresses are configuration, never constants in the app:

| Name | Example | What |
|---|---|---|
| Service | `https://share.<domain>` | the API under `/api/...`, and each share's page at `/<id>` |
| Confirmation address | `confirm@share.<domain>` | where the app sends the sender's confirmation e-mail |

The reference implementation is `src/crypto/` (TypeScript, WebCrypto only: Node 20+, browsers, Workers)
and `src/email/invitation.ts`. Both copies, the app's and the service's, pass the vectors in
`test-vectors/share-v1.json`, which an independent implementation (`node:crypto`,
`scripts/make-test-vectors.mjs`) wrote.

## 1. Keys and the link

- A share has a **share key**: 32 random bytes from a cryptographically secure generator, new for
  every share. Never reused, never derived from a password.
- The key travels only in the **fragment** of the link, base64url without padding (43 characters):

  ```
  https://share.<domain>/<id>#<key>
  ```

  A browser never sends the fragment to a server. The service never receives the key: not in a
  request, not in an e-mail, not in a log. The page makes requests to its own origin only, sends no
  `Referer`, and is never redirected (`/` is a start page, not a redirect).
- **The open proof.** To open a share, a client shows the service
  `openProof = base64url(HKDF-SHA-256(ikm = share key, salt = empty, info = "vanilla-share/v1/open", 32 bytes))`.
  The sharer sends it when creating the share; the service keeps a keyed hash. It proves knowledge of the
  key without revealing it, so the id alone (from a log, a referrer, a guess) spends no opening.
  `test-vectors/share-v1.json` has it for the vectors' key (`openProof`).
- `<id>` is the share's id: 26 characters `a-z2-7` (130 random bits), chosen by the service. Any other
  path is answered with 404.
- **The page only fetches and decrypts.** Everything that renders a file of the share (the read-only
  viewer, receipt previews, PDFs drawn with pdf.js) runs in `<iframe sandbox="allow-scripts
  allow-downloads">` **without** `allow-same-origin`, served with its own `Content-Security-Policy:
  sandbox allow-scripts allow-downloads; default-src 'none'; connect-src 'none' …`. Its origin is opaque:
  it cannot reach the page's origin, its storage, the key, or another share, and it makes no request. On
  the frame's first load the page sends it one end of a `MessageChannel` (the viewer accepts that once,
  from its parent and the page's origin); all files and requests then go over that port only. A second
  load of the frame removes it. Files larger than 50 MB are not fetched for the browser view; the page
  says so. Neither side stores a key or plaintext (no localStorage, IndexedDB or Cache API).
- The Mac app is opened from the page with `vanilla-accounting://open?share=<id>#<key>`.

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

The service sees object ids and sizes only, never a path or a name. A reader fetches the index, then
only the files it shows: the browser view loads a receipt when a person opens it.

**The envelope** (`meta`, optional, at most 8192 characters base64url) is one small blob the service
keeps in its database for the page: `{ v: 1, senderName, direction: "send" | "return", company?, note?, asOf? }`.
The page decrypts it to say who shares what without counting an opening.

## 4. Life of a share

1. **Confirm the sender, once per installation and address** (`POST /api/senders`). The service
   answers with a device token and an e-mail to send: to the confirmation address, subject
   `Vanilla Accounting confirmation <code>` (ASCII; an RFC 2047-encoded subject is decoded too). The app
   sends it from the person's own mail account. The service accepts it only with exactly one From
   address, the registered one, and when the topmost `Authentication-Results` header is Cloudflare's
   (`mx.cloudflare.net`, the only one claiming it) and shows DMARC pass for that From domain, or DKIM or
   SPF pass for a domain aligned with it. The app polls `GET /api/senders/me` until `confirmed`.
2. **Create** (`POST /api/shares`, device token): total ciphertext bytes, number of objects, the
   envelope, the open proof. The service answers with the id, the **revoke token** (the sharer's, for status and
   withdrawal), the **return token** (for the recipient, §5) and the share's URL.
3. **Upload**: `POST /api/shares/<id>/uploads` names up to 100 objects with their exact sizes and
   returns a URL per object; the app PUTs each blob there, straight to storage, with the headers given.
   A URL is valid 10 minutes and signs the size and `If-None-Match: *`: it writes its object once and
   never overwrites. An object keeps the size it was first declared with (asking again with the same
   size is a retry; another size is refused). Then `POST /api/shares/<id>/complete`: the service checks that every declared object
   arrived with its exact size and that `index` has an index header.
4. **Invite**: the app renders the invitation (`renderInvitation`, `src/email/invitation.ts`) and sends
   it from the person's own mail account, or offers «Link kopieren» and «Im Mailprogramm öffnen». The
   service sends no e-mail.
5. **Open**: one **opening** is one fetch of the index (`POST /api/shares/<id>/open` with the open
   proof). It returns the index's URL (readable twice, for a retry) and a ticket;
   `POST /api/shares/<id>/urls` (ticket and proof) turns the ticket into URLs for files, which do not
   count, and never for the index. Every read goes through the service's own origin
   (`/api/shares/<id>/objects/<name>?ticket=…`, `Range` allowed), so the page's CSP holds and every read
   is counted; no read URL points at the storage. At most **3 openings**. The first
   opening moves the end to **5 hours** later; without one, the share ends **10 days** after the upload.
6. **Watch**: `GET /api/shares/<id>/status` (revoke token): state, each opening's time, returns. The
   app asks at most every `pollAfterSeconds` (900).
7. **End**: at the end, or at once by «Zurückziehen» (`DELETE /api/shares/<id>`), the service deletes
   every object. A copy already opened stays where it was opened; nothing can recall it.

## 5. The return

The recipient sends his changes back into the same share, without a confirmation of his own:

1. His app makes a new **return key**.
2. `POST /api/shares/<id>/returns` with the return token from the index, the sizes and the return key's
   open proof (not while the share is still uploading). The return is a share of its own (its own id
   and revoke token) uploaded like any other, its index of kind `return`, sealed under the return key.
   It counts toward the sharer's 10 shares a day and the share's 5 returns.
3. He completes it with the return key sealed under the share key and bound to the return's id:
   `wrapKey(shareKey, returnKey, returnId)` (a `wrap` blob, object name = the return's id, base64url), so
   a wrapped key moved to another return fails.
4. The sharer's status lists the return with its wrapped key; her app unwraps it with the key from her
   own link (`unwrapKey(shareKey, wrapped, returnId)`) and opens the return with her revoke token and the
   return key's open proof. Returns follow the same rules (3 openings, 5
   hours after the first, 10 days at most); they are accepted for 30 days after the share and refused
   after «Zurückziehen».

## 6. What the service sees

| Sees | Never sees |
|---|---|
| a keyed hash of the confirmed sender address | the address itself, any recipient's address |
| sizes and number of objects, object ids | paths, file names, contents, the index |
| times of creation, upload, each opening, withdrawal | the key, the return key, any plaintext |
| a keyed hash of the uploading IP, for a day | names, messages, the company, figures |
| the envelope and the wrapped return key, as ciphertext | |

The hashes are HMAC-SHA-256 under a server secret; they let the service count shares per sender and per
IP. Rows of ended shares (without the envelope and the wrapped key) stay 30 days so the page can say
«abgelaufen» or «zurückgezogen», then go.

## 7. Errors

Every refusal is JSON `{ "error": "<German words for a person>", "code": "<stable code>", ... }`. A limit
names itself: `limit`, and `per` (`sender-day`, `ip-day`, `day`, `month`) where it counts. The codes are
listed in the service's `docs/api.md`.
