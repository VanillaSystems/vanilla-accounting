# Belege app redesign: notes for the Swift work

What the mockup (`index.html`) asks of `ios/Belege`, per screen. Verified against the code on
17.10.2026; guesses are marked as such.

## Branding

- Colours from `src/app/styles/tokens.css`: accent `#0067b1` (light), monochrome accent `#ededed`
  in dark, as on the Mac.
- The brand mark is the «V» wave from `desktop/icon.svg` (white on `#005B8C`, rounded square), which
  comes from the branding repo (its name and the files it delivers are in
  `desktop/brand-icons.json`). The mockup copies its path; it isn't redrawn. The lightning on the
  Mac is only the in-page «Automatisierung» button, not the brand.
- Fonts: Hanken Grotesk (the title), Instrument Sans (text), Geist Mono (amounts, dates, times).
  They would ship in the app bundle (`UIAppFonts`). Both are SIL OFL fonts *(guess: check the license files before shipping)*.

## 1 · List (`ContentView.swift`, `UploadRow`)

- A row shows its name and amount, not `capturedAt`. `PendingUpload` gains `name: String?`,
  `nameSource` (`phone`, `mac`, `person`), `amount: String?`, and a `stage` replacing `synced: Bool`:
  `waiting`, `sending`, `onMac`, `read`, `matched`, `question`. That's a SwiftData model change, so
  it needs a lightweight migration with the old `synced` mapped to `onMac`.
- Group by day, newest first. A row without a name shows «Beleg 15.10., 12:44» and «wird gelesen».
- Connection badge: `ServerConnection.State` already has `connected`, `notPaired`, `unreachable` and
  `searching`. «Mac: Handy aus» is new. *Guess:* when the Mac's phone access is off, its listener
  isn't running, so the phone sees `unreachable`, the same as «Mac nicht gefunden». Telling the two
  apart needs either a hint from Bonjour (is the Mac on the network?) or one shared message that
  names both causes. Show the Mac's name (from `/api/status` once it returns one, see Server below).
- Bottom bar: Scan (primary), photo-library import (the `PhotosPicker` already in `ContentView`), and
  a status line instead of «Sync 0». Uploading goes on its own whenever the Mac is reachable: today
  sync only starts on the button. *Guess:* retry on `ServerConnection` reaching `.connected`, plus
  a background `URLSession` for large uploads.

## 2 · Names

- **(a) On the phone:** `VNRecognizeTextRequest` (`.accurate`, languages de, fr, it, en) on page 1
  right after the scan. Name = the first prominent line (Vision gives bounding boxes; take the
  largest text in the top third), amount = a number after `TOTAL`, `Total CHF`, `Betrag`, `Summe`.
  Mark it `nameSource = phone`, shown as «vorläufig». Offline, takes under a second *(guess)*.
- **(b) From the Mac:** `POST /api/upload` already answers `{ ok, filename }` (`src/server/routes/scan.ts`).
  The phone keeps that filename and later asks for what the Mac read. There's **no such route
  today**: the phone listener allows only `GET /scan`, `GET /scan/manifest.json`, `GET /api/status`
  and `POST /api/upload` (`src/server/phone.ts`). New: `GET /api/uploads?files=a.pdf,b.pdf` with the
  same bearer token, answering per file `{ stage, vendor, total, currency, question? }`. That's
  read-only, but it's still the first route that tells the phone something about the books, so it
  needs a `docs/desktop.md` security note: vendor and total only, and only for files this token uploaded.
- **(c) By hand:** rename sets `nameSource = person`; neither (a) nor (b) overwrites it. Should the
  name reach the Mac (`X-Receipt-Name` on upload, or a later `PATCH`)? That's open, and it needs
  thought about how the books' receipt description relates to it.
- Recommendation: (a) at once, (b) replaces it, (c) wins.

## 3 · Scanner (`ScannerView.swift`)

- Today: `VNDocumentCameraViewController`. Its public API is only `delegate` and the three
  delegate callbacks. There's no property for auto or manual capture: the toggle lives inside
  Apple's UI and starts on Auto *(as far as I know: no API for it in iOS 17 or 18; check the current
  SDK headers)*. So it can't be switched off from the app.
- New: our own camera view.
  - `AVCaptureSession` with `AVCaptureVideoDataOutput` for the live frames and `AVCapturePhotoOutput`
    for the shot.
  - `VNDetectRectanglesRequest` (or `VNDetectDocumentSegmentationRequest`, iOS 15+) on preview
    frames, throttled to about 10 per second, draws the outline. No document in view means a
    dashed outline and no hint.
  - Shutter: take the photo, crop and straighten it with `CIPerspectiveCorrection` using the
    detected corners, optionally `CIColorControls` for contrast. That's the part Apple's scanner did for us.
  - Page strip: an in-memory `[UIImage]`, tap to review (move forward or back, retake, delete).
    «Fertig» goes to `PDFCreator.createPDF(from:)`, unchanged.
  - «Auto» toggle, off by default and remembered in `@AppStorage`. When on, capture after the
    outline has been stable for about 1 s, plus a short pause after each capture so a turned page
    isn't taken twice.
- Cost: this is the largest piece. Without Apple's scanner, its edge cleanup and shadow handling are
  ours to tune *(guess: about 2–3 days to get it as good)*.

## 4 · Note for the accountant

- **Where:** a step after «Fertig» (optional: «Ohne Notiz» and «Überspringen» skip it), and a «Notiz»
  row on the receipt detail to add or change it later. `PendingUpload` gains `remark: String?`.
- **Speech to text, built in only:** a plain `TextField` or `TextEditor` (axis `.vertical`). The
  keyboard's own dictation mic then works with no code and no permission, and the mockup shows
  exactly that. **Start there.**
- **Later, if wanted:** an in-app mic button using Apple's Speech framework (`SFSpeechRecognizer` with
  `requiresOnDeviceRecognition = true` where `supportsOnDeviceRecognition` is true, fed by
  `AVAudioEngine`). It needs `NSSpeechRecognitionUsageDescription` and `NSMicrophoneUsageDescription`
  in Info.plist, plus two permission prompts. It adds little over keyboard dictation, so it's not recommended for a first version.
- **Mac side (verified):** receipts already have `remarks` (`src/types/index.ts`, also in
  `ReceiptPatch`), shown as a note in the Mac app (`src/app/areas/receipts/Detail.tsx`). The phone's
  upload (`POST /api/upload`, `src/server/routes/scan.ts`) takes only the raw file and an
  `X-Captured-At` header, so the note needs the server changes listed below.

## 5 · App icon «Vanilla Belege»

- **Today:** `ios/Belege/Assets.xcassets/AppIcon.appiconset` has the brand «V» full bleed on
  `#005B8C` (1024, 180, 120, 87, 80, 60, 58, 40 px), light only, no dark or tinted variants. It's
  generated in the branding repo and listed in `desktop/brand-icons.json`.
- **Chosen (owner, 17.10.2026): B**, the Mac's «Belege» glyph (`src/app/areas/icons.tsx`, the receipt
  outline with three lines), white on `#005B8C`, no «V». A (the brand «V» alone) and C (the receipt
  with the «V» inside) stay in the mockup as not chosen. The brand lives on the launch screen and
  as the badge inside the app.
- **iOS 18 versions of B:** default (white on `#005B8C`); dark (white on near-black with a soft
  `#005B8C` glow, because the `#005B8C` tile on black is too low in contrast); tinted (the glyph alone,
  grayscale). Dark and tinted are **new files** in that AppIcon set (`Contents.json` appearances
  `dark` and `tinted`); B's default replaces today's light icon.
- **Where to make it:** the chosen icon and its dark and tinted versions belong in the branding repo
  (named in `desktop/brand-icons.json`), synced into this repo like the others, so `desktop/brand-icons.json`
  stays the source. Don't draw them here. Each is 1024 × 1024 px, square (iOS masks it), with no
  transparency in the default one.
- The name under the icon is «Belege» (`CFBundleDisplayName`): «Vanilla Belege» was squeezed on the
  home screen until it read as one word. The App Store name (set in App Store Connect, not in the app)
  can stay «Vanilla Belege».

## 6 · Launch screen

- **Chosen (owner):** always brand blue `#005B8C`, in light and dark alike. In the centre, the white
  receipt glyph of the icon (larger) with «Belege» under it in white. At the bottom, small, above the
  home indicator: the white «V» wave from `desktop/icon.svg` next to «Vanilla Accounting»: the
  maker's mark (endorsed brand). Apple suggests the app's empty first screen instead; the owner chose
  the branded one.
- Today `project.yml` has `UILaunchScreen: {}`, which shows a blank screen. Set it through Info.plist's
  `UILaunchScreen` keys, no storyboard needed:
  - `UIColorName`: a colour asset, for example `LaunchBlue` = `#005B8C`, the same for Any and Dark.
  - `UIImageName`: **one image holding glyph, name and footer**, as a PDF or SVG vector in the asset
    catalog, sized to the screen width. `UILaunchScreen` centres the image and can't place a second
    element at the bottom, so the footer has to be part of the same image. The catch: a single centred
    image can't pin the footer to the bottom edge on every screen height. On taller phones it sits a
    little higher than the bottom. If that looks wrong, the fallback is **glyph only** in the image
    (no «Belege», no footer), and the maker's mark appears on the app's first screen instead
    *(guess: the full image will look fine across current iPhones; check on the smallest and the largest)*.
  - Make the image in the branding repo too, from the same glyph and wave.

## 7 · Pairing (`PairingScannerView.swift`, `Pairing.swift`)

- The flow stays the same: scan `http://<addr>:<port>/scan#token=…`. Only the screen changes: the
  steps written out («Am Mac: Firma › Handy … einschalten»), the frame, and a confirmation naming
  the Mac and the company.

## 8 · Who uploaded it

Every receipt from a phone records who took it, so the accountant knows whom to ask.

- **Asked at pairing: only an email.** Right after the code, one field: «Wie erreicht dich die
  Buchhaltung bei Fragen?». The email is the label shown for that phone and the contact address. It's shortened
  where space is tight (the local part, «anna.muster»), and shown in full in detail views and on the Mac.
  It can be changed later in Settings.
  - It isn't verified: a typo goes unnoticed. An emailed one-time code could verify it later, not now.
  - A name can be added later on the Mac (Firma › Handy) if wanted.
  - One person with two phones is fine: two phones, one email.
  - One-person firms skip the question and use the workspace's owner (`company.owner` in
    `belege.workspace.yaml`) until a second phone pairs.
- **Phase 1 (built):** the email step after a successful pairing (`EmailStepView` in `SettingsView.swift`)
  and the field in Settings, stored on the phone (`PhonePerson.emailKey`), shown on the receipt detail
  as «Von …». Not sent; the code marks that as phase 4.
- **Phase 4, on the server, with the note:**
  - **Today all phones share one token** (docs/desktop.md: «Neuen Code erstellen» replaces it for every
    phone), so the Mac can't tell phones apart, and an email sent as a header would be spoofable.
  - **Per-phone pairing:** the phone registers once with its email and device model and gets its own
    token. The Mac keeps a list of paired phones in Firma › Handy (email, optional name, device, last
    upload), each removable on its own. An upload is attributed **by its token**, not by a header.
  - **The person's data lives once, with the paired phone**, not on each receipt. The receipt only
    references the phone. So personal data stays out of every receipt record in the books' git history,
    and an address changed later applies everywhere.
  - **The receipt's origin** (R1 in `docs/0.4.0/collection-requirements.md`): from which phone (its
    id), which channel, when. A new receipt field means a **books schema bump with a migration step**
    (`src/workspace/schema.ts`, AGENTS.md «Versions and data format»).
  - **The same for the other channels:** a drop records the person at the Mac, a mail its sender.
  - **Mac follow-up:** the receipt detail shows «Von anna.muster@…» with a mail action that prefills the
    receipt's details (date, amount, name), for the accountant's question.
  - **docs/desktop.md must then say** (security): tokens are per phone, each one revocable on its own,
    and «Neuen Code erstellen» no longer affects phones already paired. The email is unverified,
    self-declared contact data, not an identity: the token is what's trusted. And the list of phones holds
    personal data (email, device), kept in the user data folder or the workspace (to decide), not in git
    history per receipt.

## Server

1. `GET /api/status`: add the Mac's name and the company name, for the badge and the pairing confirmation.
2. `GET /api/uploads?files=…`: stage, vendor and total per uploaded file (names (b)).
3. Optional: `X-Receipt-Name` on `POST /api/upload` for a person's name.
4. Note on upload: an `X-Note` header (percent-encoded UTF-8) on `POST /api/upload`. The route keeps it
   beside the inbox file (for example a sidecar `<file>.note`, or the inbox ledger), and the intake puts it
   on the new receipt's `remarks`. *(Guess on the carrier; the intake code wasn't read for this.)*
5. Note after the upload: a small update route, for example `PATCH /api/uploads/<filename>`
   `{ note }`. It writes `remarks` on that receipt, or keeps it for the intake if the file hasn't been
   read yet. It's limited to files this token uploaded, and it's a write, so it runs through `withBooks`
   and `assertOpen` like every route that writes (AGENTS.md, period lock).
6. Per-phone pairing (section 8): register with email and device model, own token, paired-phones list in Firma › Handy; uploads attributed by token; a receipt origin field with a schema bump.

Each route goes into `PHONE_ROUTES` (`src/server/phone.ts`) and into `docs/desktop.md`'s table.

## Order of work

1. List redesign with branding and day groups; model migration; automatic upload. *(Phone only.)*
2. Names (a) with Vision, rename (c), and the note with keyboard dictation, kept on the phone. *(Phone only.)*
   App icon (B, three appearances) and launch screen (blue, one image) alongside: assets and Info.plist only.
3. Custom camera with the page strip. *(Phone only; the largest piece.)*
4. Server routes 1, 2, 4, 5 and 6 (per-phone pairing), then names (b), the note reaching `remarks`, and the receipt's origin. *(Phone and Mac.)*
5. Pairing screen polish.
