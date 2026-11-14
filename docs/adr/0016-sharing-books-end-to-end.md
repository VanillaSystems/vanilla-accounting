# ADR 0016: Sharing books end to end through a host that cannot read them

**Status: accepted (owner, 2026-11-14), not built.** Spec:
[docs/specs/e2e-and-fiduciary.md](../specs/e2e-and-fiduciary.md), Part B. Prototype: PR #530
(`docs/0.4.0/mockups/share/`). The service lives in a private repository (`vanilla-share`); its
protocol is that repository's `docs/protocol.md`.

## Context

An owner books her company and wants a fiduciary to look at it: often a family member, not
technical, without an account anywhere and without git. ADR 0003 keeps the books local-first in
git and plans a cloud instance for outsiders, which needs logins, a server holding the books and
someone to run it. A file sent by hand (a `.vanilla` file, the spec's first draft) works without
any of that, but leaves the person to find a way to send 60 MB, and the sharer never learns
whether it arrived.

The books hold a company's whole finances. Whoever stores them for the trip must not be able to
read them, and must not become a place where twenty years of books pile up.

## Decision

- **A link, not a file.** «Teilen…» in the app encrypts every file of the package on its own (a
  random 256-bit key per share, AES-GCM) with an encrypted index, and uploads only ciphertext to
  the share service (`<domain>` is the publisher's domain, named in README.md).
- **The invitation comes from the sharer's own mail account**, from a template the service's
  repository provides. It holds the link `https://share.<domain>/<id>#<key>`. The key sits in the
  fragment, which a browser never sends. The service never receives the key and sends no e-mail
  with it; in v1 it has no e-mail provider at all.
- **The sender confirms her address once** by an e-mail the app sends from that account to the
  service's inbound address, checked by DKIM or SPF. It keeps the upload API from becoming free
  anonymous storage.
- **Two ways to open, both in v1.** The page shows the books read-only in any browser: the app's
  read-only build decrypts the index there and loads receipts lazily, inside an
  `<iframe sandbox="allow-scripts">` without `allow-same-origin`, fed by `postMessage`. On a Mac it also installs the app and opens the books in it
  (`vanilla-accounting://open?share=<id>#<key>`) to work on them.
- **The same package both ways.** The first share carries the open years, later ones the books'
  files and only the new receipts. The recipient's return is his change set, uploaded to the same
  share with its key wrapped under the share's key. The sharer takes it over through the write
  door, by record, after review.
- **No PIN, no login, no accounts.** Whoever has the e-mail can open the books. The protections
  are time and count: deleted 5 hours after the first opening, at the latest after 10 days; at most
  3 openings within those 5 hours; the sharer sees «geöffnet am …»; «Zurückziehen» deletes at once.
- **Cloudflare now** (a Worker, R2 storage, Email Routing for the confirmation), within the free
  tier, with hard caps: 1 GB per share, 10 shares per sender and day, 5 GB stored in total. Free for
  the person.
- **The `.vanilla` file stays** as the offline way (a USB stick, SwissTransfer), with the same
  format.

## Consequences

- **The host stores nothing it can read**, and never holds a key. Moving it is a matter of trust,
  not of data: a Swiss host later takes over `share.<domain>` by a DNS change, and the app does not
  change. What the service does see is the sender's confirmed address, sizes and times.
- **The app must be able to send mail.** It uses the account it reads receipts from (SMTP or Mail
  on the Mac). Without one, the person copies the link or opens it in her mail program.
- **One origin, shares isolated by a sandboxed frame.** The page's script handles a key, so one
  share's content must not reach another's. A subdomain per share would give each its own origin,
  but `<id>.share.<domain>` needs a wildcard certificate two levels deep, which Cloudflare's free
  plan does not issue, and dynamic hostnames are a hassle to route and to test. Instead every share
  lives under the path `share.<domain>/<id>`, and its content (the viewer, receipt previews) runs in
  an `<iframe sandbox="allow-scripts">` without `allow-same-origin`: an opaque origin with no
  access to cookies, storage or other frames. Keys and decrypted data stay in memory, never in
  browser storage; a strict Content-Security-Policy and `Referrer-Policy: no-referrer` close the
  rest. The cost: the frame and the page talk only by `postMessage`, and the viewer must work
  without storage.
- **No PIN, no login, on purpose.** A PIN sent in the same e-mail protects nothing, and one sent
  another way is a step a 71-year-old fiduciary fails at; an account is a password he forgets for
  a quarterly visit. The e-mail address is the identity, as it is for every invoice the company
  sends. The 5 hours and the 3 openings bound a forwarded or leaked e-mail. An account for
  fiduciaries with many mandates (keys stored encrypted per user) is a later phase and stays
  optional.
- **«Zurückziehen» cannot recall a copy.** It deletes what the service holds. A copy the
  recipient has already opened stays on his Mac, as a printed binder would. The app says so on the
  share card and never claims more.
- **A copy moves forward only on its sharer's signature** (added in the reviews of PR #538). A link
  is someone else's data: anyone can make one naming any firm, sharer and UID. So the sharer's app
  keeps an Ed25519 key pair per books and recipient (the private key in the secret store, never in
  the books or a link) and signs every package's index, whose files are named with their SHA-256,
  so the signature covers the content. The recipient's copy pins the public key of its first link
  (trust on first use; that first link, like any link opened by the system's URL scheme, is shown
  with its service and claims before it opens) and moves forward without a question only for a
  package that verifies against the pinned key. Any other package that would move the copy is
  refused until the person confirms it, shown the copy's real facts beside the package's claims and
  told that the sender cannot be verified. A forwarded invitation reveals the public key alone.
  Copies made before signatures pin the key on their next link after one confirmation. A link to
  another service than the app's is confirmed the same way. The `.vanilla` file carries no
  signature: opening a file is the person's own act.
- **The return is a proposal.** Nothing the recipient changes reaches the books until the sharer
  takes it over, and a filed quarter stays as filed on both sides.
- **New things to run:** the service, the inbound confirmation address, the page with the
  read-only build, and the app's URL scheme. Until the app is signed with an Apple Developer ID,
  the page must walk the recipient through «Dennoch öffnen» in the system settings.
