import SwiftUI
import SwiftData
import PDFKit

/// One receipt: its pages, a name the person can give it, and a note for the accountant.
struct ReceiptDetailView: View {
    @Bindable var upload: PendingUpload
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @State private var showDelete = false
    @State private var showPDF = false
    @AppStorage(PhonePerson.emailKey) private var person = ""

    var body: some View {
        Form {
            Section {
                Button { showPDF = true } label: {
                    PagePreview(url: upload.fileURL, pages: upload.pageCount)
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets())
                .accessibilityLabel("Beleg ganz anzeigen")
            }

            Section {
                TextField(upload.displayName, text: Binding(
                    get: { upload.name ?? "" },
                    set: { upload.name = $0.isEmpty ? nil : $0 }
                ))
                .font(.sans(16, .medium))
            } header: {
                Text("Name")
            } footer: {
                Text(upload.isProvisional
                     ? "Vorläufig: vom Handy aus dem Belegtext gelesen. Ein eigener Name gilt immer und bleibt vorerst auf diesem Handy."
                     : "Bleibt vorerst auf diesem Handy. Auf dem Mac bekommt der Beleg seinen Namen von dem, was der Mac liest.")
            }

            Section {
                NoteField(note: $upload.note)
            } header: {
                Text("Notiz für die Buchhaltung")
            } footer: {
                // Phase 4 sends the note with the receipt (see docs/0.4.0/mockups/phone-app/NOTES.md).
                Text("Diktieren geht mit dem Mikrofon der Tastatur. Die Notiz bleibt vorerst auf dem Handy; ans Mac geht sie mit einem nächsten Update.")
            }

            Section {
                LabeledContent("Aufgenommen") {
                    Text(upload.capturedAt.formatted(.dateTime.day().month(.twoDigits).year().hour().minute().locale(Locale(identifier: "de_CH"))))
                        .font(.mono(14))
                }
                // This phone's person; phase 4 records the phone on the Mac, and the Mac shows «Von …».
                LabeledContent("Von") {
                    Text(person.isEmpty ? "Keine E-Mail hinterlegt" : person).foregroundStyle(person.isEmpty ? Color.muted : Color.ink)
                }
                LabeledContent("Seiten") { Text("\(upload.pageCount)").font(.mono(14)) }
                if let size = upload.fileSize {
                    LabeledContent("Grösse") { Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file)).font(.mono(14)) }
                }
                LabeledContent("Stand") {
                    Label(upload.synced ? "auf dem Mac" : "wartet aufs Senden", systemImage: upload.synced ? "desktopcomputer" : "clock")
                        .labelStyle(.compact)
                        .foregroundStyle(upload.synced ? Color.ink2 : Color.muted)
                }
            }
            .font(.sans(15))

            Section {
                ShareLink(item: upload.fileURL) { Label("Kopie senden", systemImage: "square.and.arrow.up") }
                Button(upload.synced ? "Vom Handy löschen" : "Beleg löschen", role: .destructive) { showDelete = true }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.background)
        .navigationTitle(upload.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: $showPDF) {
            PDFViewer(url: upload.fileURL, title: upload.displayName)
        }
        .confirmationDialog("Diesen Beleg löschen?", isPresented: $showDelete, titleVisibility: .visible) {
            Button("Löschen", role: .destructive) {
                try? FileManager.default.removeItem(at: upload.fileURL)
                try? FileManager.default.removeItem(at: upload.headerURL)
                modelContext.delete(upload)
                try? modelContext.save()
                dismiss()
            }
        } message: {
            Text(upload.synced ? "Er bleibt auf dem Mac." : "Er ist noch nicht auf dem Mac.")
        }
    }
}

/// A plain multi-line text field: the keyboard's own dictation works with it, no permission needed.
struct NoteField: View {
    @Binding var note: String?

    var body: some View {
        TextField("Bewirtung Kunde Müller, 3 Personen", text: Binding(
            get: { note ?? "" },
            set: { note = $0.isEmpty ? nil : $0 }
        ), axis: .vertical)
        .lineLimit(3...6)
        .font(.sans(16))
    }
}

/// Right after «Fertig» in the scanner: an optional note, skippable.
struct NoteStepView: View {
    @Bindable var upload: PendingUpload
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ReceiptTile(upload: upload)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(upload.displayName).font(.sans(16, .medium)).foregroundStyle(Color.ink)
                        Text("\(upload.pageCount) \(upload.pageCount == 1 ? "Seite" : "Seiten")").font(.mono(13)).foregroundStyle(Color.ink2)
                    }
                    Spacer()
                }
                .padding(12)
                .background(Color.group, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                Text("Notiz für die Buchhaltung").font(.head(22, relativeTo: .title2)).foregroundStyle(Color.ink)
                Text("Freiwillig. Wofür war es?").font(.sans(13)).foregroundStyle(Color.muted)

                TextField("Bewirtung Kunde Müller, 3 Personen", text: $draft, axis: .vertical)
                    .lineLimit(3...6)
                    .font(.sans(16))
                    .padding(12)
                    .background(Color.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.accent, lineWidth: 1.5))
                    .focused($focused)

                Label("Lieber sprechen? Das Mikrofon unten an der Tastatur.", systemImage: "mic")
                    .labelStyle(.compact)
                    .font(.sans(12, relativeTo: .caption))
                    .foregroundStyle(Color.muted)

                Spacer()

                HStack(spacing: 10) {
                    Button("Ohne Notiz") { dismiss() }
                        .font(.sans(16, .medium))
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundStyle(Color.ink)
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.line2))
                    Button("Sichern") { save() }
                        .font(.sans(16, .semibold))
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .foregroundStyle(Color.onAccent)
                        .background(Color.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .padding(20)
            .background(Color.background)
            .navigationTitle("Neuer Beleg")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Überspringen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Sichern") { save() }.fontWeight(.semibold) }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.large])
    }

    private func save() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // Kept on the phone for now; phase 4 sends it with the upload.
        if !text.isEmpty { upload.note = text }
        dismiss()
    }
}

/// Page 1 as a still image (no scrolling in a small box), with the page count when there are more.
struct PagePreview: View {
    let url: URL
    let pages: Int
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color.group
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .shadow(color: .black.opacity(0.15), radius: 6, y: 3)
                    .padding(16)
            } else {
                ProgressView()
            }
        }
        .frame(height: 300)
        .overlay(alignment: .bottomTrailing) {
            if pages > 1 {
                Text("\(pages) Seiten")
                    .font(.mono(11, .medium, relativeTo: .caption))
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
                    .foregroundStyle(.white)
                    .padding(12)
            }
        }
        .task(id: url) {
            image = await Task.detached { ReceiptRecognizer.firstPage(of: url).map { UIImage(cgImage: $0) } }.value
        }
    }
}

/// The whole receipt full screen, like a photo: all pages, pinch to zoom, «Fertig» or swipe down to close.
struct PDFViewer: View {
    let url: URL
    let title: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PDFKitView(url: url)
                .ignoresSafeArea(edges: .bottom)
                .background(Color.black)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(.black, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbarColorScheme(.dark, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Fertig") { dismiss() } }
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                    }
                }
        }
        .gesture(DragGesture().onEnded { if $0.translation.height > 120 && abs($0.translation.width) < 80 { dismiss() } })
        .preferredColorScheme(.dark)
    }
}

struct PDFKitView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> FitWidthPDFView {
        let view = FitWidthPDFView()
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .black
        view.pageShadowsEnabled = false
        view.displaysPageBreaks = true
        view.pageBreakMargins = UIEdgeInsets(top: 0, left: 0, bottom: 6, right: 0)
        view.document = PDFDocument(url: url)
        return view
    }

    func updateUIView(_ view: FitWidthPDFView, context: Context) {
        if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
    }
}

/// Opens at exactly the screen's width, at the top of page 1; zooming in is possible, never smaller than
/// full width. Recomputed whenever the width changes (rotation).
final class FitWidthPDFView: PDFView {
    private var fittedWidth: CGFloat = 0
    private var wentToTop = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        autoScales = false
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        autoScales = false
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, abs(bounds.width - fittedWidth) > 0.5, let page = document?.page(at: 0) else { return }
        fittedWidth = bounds.width
        let box = page.bounds(for: .mediaBox)
        let pageWidth = page.rotation % 180 == 0 ? box.width : box.height
        guard pageWidth > 0 else { return }
        let fit = bounds.width / pageWidth
        // Widen the range first so the new factor isn't clamped by the old one.
        maxScaleFactor = max(maxScaleFactor, fit * 6)
        minScaleFactor = min(minScaleFactor, fit)
        scaleFactor = fit
        minScaleFactor = fit
        maxScaleFactor = fit * 6
        guard !wentToTop else { return }
        wentToTop = true
        DispatchQueue.main.async { [weak self] in
            self?.go(to: PDFDestination(page: page, at: CGPoint(x: box.minX, y: box.maxY)))
        }
    }
}
