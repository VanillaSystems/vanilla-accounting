import SwiftUI
import SwiftData
import PhotosUI
import PDFKit

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \PendingUpload.capturedAt, order: .reverse) private var uploads: [PendingUpload]
    @StateObject private var server = ServerConnection()

    @State private var showScanner = false
    @State private var showSettings = false
    @State private var isProcessing = false
    @State private var isSyncing = false
    @State private var sending: Set<UUID> = []
    @State private var syncError: String?
    @State private var showDeleteConfirm = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    /// The receipt just scanned: the note step opens for it.
    @State private var noteFor: PendingUpload?
    @State private var isRecognizing = false
    @State private var tab: Tab = .toSend
    /// Settings › «Gesendete nach 30 Tagen vom Handy löschen» (off by default; an automation, not a reminder).
    @AppStorage("autoDeleteSentAfter30Days") private var autoDeleteSent = false

    enum Tab: Hashable { case toSend, sent }

    private var pendingUploads: [PendingUpload] { uploads.filter { !$0.synced } }
    private var syncedUploads: [PendingUpload] { uploads.filter { $0.synced } }

    var body: some View {
        NavigationStack {
            List {
                Picker("Ansicht", selection: $tab) {
                    Text("Zu senden (\(pendingUploads.count))").tag(Tab.toSend)
                    Text("Gesendet").tag(Tab.sent)
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)

                connectionRow
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)

                switch tab {
                case .toSend:
                    if pendingUploads.isEmpty {
                        calm(uploads.isEmpty ? "Noch keine Belege" : "Alles auf dem Mac",
                             uploads.isEmpty ? "Tippe auf «Scannen», um einen Beleg zu fotografieren, oder hol Fotos aus der Fotomediathek."
                                             : "Neue Belege: «Scannen» unten.",
                             symbol: uploads.isEmpty ? "doc.text.viewfinder" : "checkmark.circle")
                    } else {
                        dayGroups(of: pendingUploads)
                    }
                case .sent:
                    if syncedUploads.isEmpty {
                        calm("Noch nichts gesendet", "Gesendete Belege bleiben hier, bis du sie vom Handy löschst.", symbol: "tray")
                    } else {
                        dayGroups(of: syncedUploads)
                        Section {
                            Button("Gesendete löschen …", role: .destructive) { showDeleteConfirm = true }
                                .font(.sans(15, .medium))
                        } footer: {
                            Text("Sie bleiben auf dem Mac.")
                        }
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Belege")
            .navigationDestination(for: UUID.self) { id in
                if let upload = uploads.first(where: { $0.id == id }) {
                    ReceiptDetailView(upload: upload)
                }
            }
            .toolbar {
                BrandMarkToolbarItem()
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Einstellungen")
                }
            }
            .safeAreaInset(edge: .bottom) {
                bottomBar
            }
        }
        .tint(Color.accent)
        .sheet(isPresented: $showScanner) {
            ScannerView(onScan: handleScan, onCancel: { showScanner = false })
                .ignoresSafeArea()
        }
        .sheet(item: $noteFor) { upload in
            NoteStepView(upload: upload)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(server: server)
        }
        .confirmationDialog(
            "\(syncedUploads.count) gesendete\(syncedUploads.count == 1 ? "n Beleg" : " Belege") vom Handy löschen?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Vom Handy löschen", role: .destructive) { deleteSynced() }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Sie bleiben auf dem Mac. Nur auf diesem Handy werden sie entfernt.")
        }
        .alert("Senden hat nicht geklappt", isPresented: .constant(syncError != nil)) {
            Button("OK") { syncError = nil }
        } message: {
            Text(syncError ?? "")
        }
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickedPhotos = []
            handlePhotos(items)
        }
        .onAppear {
            server.start()
            deleteOldSentIfWanted()
        }
        .task { await recognizeMissing() }
        .onDisappear { server.stop() }
    }

    /// Receipts grouped by day, newest first, each row with its swipe and context actions.
    @ViewBuilder private func dayGroups(of list: [PendingUpload]) -> some View {
        ForEach(days(of: list), id: \.day) { group in
            Section {
                ForEach(group.uploads) { upload in
                    NavigationLink(value: upload.id) {
                        UploadRow(upload: upload, sending: sending.contains(upload.id))
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) { delete([upload]) } label: {
                            Label("Löschen", systemImage: "trash")
                        }
                        if upload.synced {
                            ShareLink(item: upload.fileURL) { Label("Kopie senden", systemImage: "square.and.arrow.up") }
                                .tint(Color.ink2)
                        }
                    }
                    .contextMenu {
                        ShareLink(item: upload.fileURL) { Label("Kopie senden", systemImage: "square.and.arrow.up") }
                        Button(role: .destructive) { delete([upload]) } label: {
                            Label(upload.synced ? "Vom Handy löschen" : "Löschen", systemImage: "trash")
                        }
                    }
                }
            } header: {
                HStack {
                    Text(dayTitle(group.day))
                    Spacer()
                    Text("\(group.uploads.count)")
                }
                .font(.mono(11.5, relativeTo: .caption))
                .textCase(.uppercase)
                .foregroundStyle(Color.muted)
            }
        }
    }

    private func calm(_ title: String, _ text: String, symbol: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(text)
        }
        .background {
            // «Alles auf dem Mac»: the wave alone, very faint, as a watermark.
            if title == "Alles auf dem Mac" {
                WaveShape().fill(Color.ink.opacity(0.045)).frame(width: 240, height: 175)
            }
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// Under the title: a quiet line when all is well, the banner when the Mac can't be reached.
    @ViewBuilder private var connectionRow: some View {
        switch badgeState {
        case .connected:
            HStack(spacing: 6) {
                Circle().fill(Color.pos).frame(width: 7, height: 7)
                Text("Mac verbunden")
            }
            .font(.sans(13, relativeTo: .footnote))
            .foregroundStyle(Color.muted)
        case .searching:
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Sucht den Mac …")
            }
            .font(.sans(13, relativeTo: .footnote))
            .foregroundStyle(Color.muted)
        case .away, .unpaired:
            if let message = connectionMessage {
                Button { showSettings = true } label: {
                    ConnectionBanner(title: message.title, text: message.text)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Settings › «Gesendete nach 30 Tagen vom Handy löschen»: they stay on the Mac.
    private func deleteOldSentIfWanted() {
        guard autoDeleteSent else { return }
        let cutoff = Date().addingTimeInterval(-30 * 24 * 3600)
        let old = syncedUploads.filter { ($0.syncedAt ?? $0.capturedAt) < cutoff }
        if !old.isEmpty { delete(old) }
    }

    // MARK: - Grouping

    private func days(of list: [PendingUpload]) -> [(day: Date, uploads: [PendingUpload])] {
        let cal = Calendar.current
        let grouped = Dictionary(grouping: list) { cal.startOfDay(for: $0.capturedAt) }
        return grouped.keys.sorted(by: >).map { ($0, grouped[$0]!) }
    }

    private func dayTitle(_ day: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(day) { return "Heute" }
        if cal.isDateInYesterday(day) { return "Gestern" }
        return day.formatted(.dateTime.weekday(.wide).day().month(.abbreviated).locale(Locale(identifier: "de_CH")))
    }

    // MARK: - Connection

    enum ConnectionKind { case connected, searching, away, unpaired }

    private var badgeState: ConnectionKind {
        if server.storedURLString.isEmpty || TokenStore.load() == nil { return .unpaired }
        switch server.state {
        case .connected: return .connected
        case .notPaired: return .unpaired
        case .searching, .unknown: return .searching
        case .unreachable: return .away
        }
    }

    /// The phone can't tell a Mac that is off, on another Wi-Fi or with «Handy» switched off apart:
    /// all three leave it unreachable. So one message names all three.
    private var connectionMessage: (title: String, text: String)? {
        switch badgeState {
        case .away:
            return ("Mac nicht erreichbar", "Ist er an und im selben WLAN, und ist am Mac unter Firma › Handy der Zugang eingeschaltet? Deine Belege warten hier und gehen danach.")
        case .unpaired:
            return ("Noch nicht mit dem Mac verbunden", "Tippe hier und scanne den Code, den der Mac unter Firma › Handy zeigt.")
        default:
            return nil
        }
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    showScanner = true
                } label: {
                    Label(isProcessing ? "Wird gespeichert …" : "Scannen", systemImage: "doc.viewfinder")
                        .font(.sans(17, .semibold, relativeTo: .headline))
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .foregroundStyle(Color.onAccent)
                        .background(Color.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .disabled(isProcessing)

                PhotosPicker(selection: $pickedPhotos, maxSelectionCount: 20, matching: .images) {
                    Image(systemName: "photo.on.rectangle")
                        .font(.title3)
                        .frame(width: 56, height: 52)
                        .foregroundStyle(Color.ink)
                        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.line2))
                }
                .accessibilityLabel("Fotos importieren")
                .disabled(isProcessing)
            }
            syncLine
                .font(.sans(12.5, relativeTo: .caption))
                .foregroundStyle(Color.muted)
                .frame(minHeight: 18)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .background(.regularMaterial)
    }

    @ViewBuilder private var syncLine: some View {
        let n = pendingUploads.count
        let waiting = "\(n) \(n == 1 ? "wartet" : "warten")"
        if isSyncing {
            HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("sendet …") }
        } else if n == 0 {
            Text(uploads.isEmpty ? " " : "Alles auf dem Mac")
        } else if let url = server.serverURL, server.state == .connected {
            HStack(spacing: 4) {
                Text("\(waiting) ·")
                Button("Jetzt senden") { Task { await syncAll(to: url) } }
                    .font(.sans(12.5, .semibold, relativeTo: .caption))
            }
        } else {
            Text("\(waiting) · gehen, sobald der Mac da ist")
        }
    }

    // MARK: - Actions

    private func handleScan(_ images: [UIImage]) {
        showScanner = false
        isProcessing = true

        Task {
            let upload = await savePending(images: images, capturedAt: Date(), suffix: "")
            isProcessing = false
            noteFor = upload
            await recognizeMissing()
        }
    }

    /// Photos taken with the regular camera: each one is a receipt of its own.
    private func handlePhotos(_ items: [PhotosPickerItem]) {
        isProcessing = true

        Task {
            let importedAt = Date()
            for (index, item) in items.enumerated() {
                guard let data = try? await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: data) else { continue }
                _ = await savePending(images: [image], capturedAt: importedAt, suffix: items.count > 1 ? "-\(index + 1)" : "")
            }
            isProcessing = false
            await recognizeMissing()
        }
    }

    /// The PDF is made off the main thread; the model is inserted on it (SwiftData models stay on their actor).
    @discardableResult
    private func savePending(images: [UIImage], capturedAt: Date, suffix: String) async -> PendingUpload? {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let filename = "\(formatter.string(from: capturedAt))\(suffix).pdf"
        let fileURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(filename)

        let written = await Task.detached(priority: .userInitiated) { () -> Bool in
            guard let pdfData = PDFCreator.createPDF(from: images) else { return false }
            return (try? pdfData.write(to: fileURL)) != nil
        }.value
        guard written else { return nil }

        let upload = PendingUpload(filename: filename, capturedAt: capturedAt, pageCount: images.count)
        modelContext.insert(upload)
        return upload
    }

    private func syncAll(to serverURL: URL) async {
        let pending = uploads.filter { !$0.synced }
        guard !pending.isEmpty else { return }

        isSyncing = true
        syncError = nil

        for upload in pending {
            sending.insert(upload.id)
            do {
                try await UploadService.upload(upload, to: serverURL, token: server.token)
                upload.synced = true
                upload.syncedAt = Date()
                try? modelContext.save()
            } catch {
                syncError = error.localizedDescription
                sending.remove(upload.id)
                break
            }
            sending.remove(upload.id)
        }

        isSyncing = false
    }

    /// Names and header tiles for receipts that don't have them yet: new scans and imports, and once the
    /// receipts stored before this version. One at a time, in the background; a name typed by hand is never touched.
    private func recognizeMissing() async {
        guard !isRecognizing else { return }
        isRecognizing = true
        defer { isRecognizing = false }
        while let upload = uploads.first(where: { ($0.guessVersion ?? 0) < ReceiptNaming.version && FileManager.default.fileExists(atPath: $0.fileURL.path) }) {
            let url = upload.fileURL
            let headerURL = upload.headerURL
            let guess: String? = await Task.detached(priority: .utility) {
                let result = ReceiptRecognizer.analyze(pdf: url)
                if let data = result.header?.jpegData(compressionQuality: 0.8) { try? data.write(to: headerURL) }
                return ReceiptNaming.name(fromLines: result.lines)
            }.value
            upload.guessedName = guess
            upload.guessVersion = ReceiptNaming.version
            try? modelContext.save()
            print("[Belege] named \(upload.filename): \(guess ?? "(nothing found)")")
        }
    }

    private func delete(_ items: [PendingUpload]) {
        let fm = FileManager.default
        for upload in items {
            try? fm.removeItem(at: upload.fileURL)
            try? fm.removeItem(at: upload.headerURL)
            modelContext.delete(upload)
        }
        try? modelContext.save()
    }

    private func deleteSynced() { delete(syncedUploads) }
}

// MARK: - Rows

struct UploadRow: View {
    let upload: PendingUpload
    var sending = false

    var body: some View {
        HStack(spacing: 12) {
            ReceiptTile(upload: upload)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(upload.displayName)
                        .font(.sans(16, .medium))
                        .foregroundStyle(upload.name == nil && upload.guessedName == nil ? Color.ink2 : Color.ink)
                        .lineLimit(1)
                    if upload.isProvisional { ProvisionalMark() }
                }
                HStack(spacing: 5) {
                    stage
                    Text("·").foregroundStyle(Color.faint)
                    Text("\(upload.pageCount) \(upload.pageCount == 1 ? "Seite" : "Seiten")")
                    if upload.note?.isEmpty == false {
                        Text("·").foregroundStyle(Color.faint)
                        Image(systemName: "text.bubble").accessibilityLabel("mit Notiz")
                    }
                }
                .font(.sans(12.5, relativeTo: .caption))
                .foregroundStyle(Color.muted)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }

    /// One quiet state per receipt. Read and matched come with phase 4, when the phone can ask the Mac.
    @ViewBuilder private var stage: some View {
        if sending {
            HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("wird gesendet") }
        } else if upload.synced {
            Label("auf dem Mac", systemImage: "desktopcomputer").foregroundStyle(Color.ink2).labelStyle(.compact)
        } else {
            Label("wartet aufs Senden", systemImage: "clock").labelStyle(.compact)
        }
    }
}

struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) { configuration.icon.imageScale(.small); configuration.title }
    }
}

extension LabelStyle where Self == CompactLabelStyle {
    static var compact: CompactLabelStyle { CompactLabelStyle() }
}

/// The receipt's header (its top band, cropped by the recognition), so the shop's name or logo shows.
/// Without one: the supplier's initials on the brand blue; before recognition: a plain page.
struct ReceiptTile: View {
    let upload: PendingUpload
    var width: CGFloat = 56
    @State private var header: UIImage?

    var body: some View {
        ZStack {
            if let header {
                Color.white
                Image(uiImage: header).resizable().scaledToFit().padding(3)
            } else if let initials = upload.initials {
                Color.brandBlue
                Text(initials).font(.head(17, relativeTo: .headline)).foregroundStyle(.white)
            } else {
                Color.group
                Image(systemName: "doc.text").foregroundStyle(Color.muted)
            }
        }
        .frame(width: width, height: width * 0.75)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(Color.line2))
        .overlay(alignment: .bottomTrailing) {
            if upload.pageCount > 1 {
                Text("\(upload.pageCount)")
                    .font(.mono(9.5, .medium, relativeTo: .caption2))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Color.ink.opacity(0.75), in: RoundedRectangle(cornerRadius: 4))
                    .foregroundStyle(Color.background)
                    .offset(x: 3, y: 3)
            }
        }
        .task(id: upload.guessVersion) {
            let url = upload.headerURL
            header = await Task.detached { UIImage(contentsOfFile: url.path) }.value
        }
        .accessibilityHidden(true)
    }
}

/// The quiet marker of a name the phone guessed.
struct ProvisionalMark: View {
    var body: some View {
        Text("vorläufig")
            .font(.sans(10.5, .medium, relativeTo: .caption2))
            .foregroundStyle(Color.muted)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line2))
            .fixedSize()
    }
}

// MARK: - Connection

/// The brand's lockup at the top left; on iOS 26 without the toolbar's glass capsule around it.
struct BrandMarkToolbarItem: ToolbarContent {
    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .topBarLeading) { BrandLockup(height: 26) }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { BrandLockup(height: 26) }
        }
    }
}

struct ConnectionBanner: View {
    let title: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "desktopcomputer").foregroundStyle(Color.warn)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.sans(13.5, .semibold)).foregroundStyle(Color.warn)
                Text(text).font(.sans(13)).foregroundStyle(Color.ink2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.warnSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
