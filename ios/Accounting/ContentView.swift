import SwiftUI
import SwiftData

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \PendingUpload.capturedAt, order: .reverse) private var uploads: [PendingUpload]
    @StateObject private var server = ServerConnection()

    @State private var showScanner = false
    @State private var showSettings = false
    @State private var isProcessing = false
    @State private var isSyncing = false
    @State private var syncProgress = (done: 0, total: 0)
    @State private var syncError: String?
    @State private var showDeleteConfirm = false

    private var pendingUploads: [PendingUpload] { uploads.filter { !$0.synced } }
    private var syncedUploads: [PendingUpload] { uploads.filter { $0.synced } }

    var body: some View {
        NavigationStack {
            List {
                if uploads.isEmpty {
                    ContentUnavailableView(
                        "No Receipts",
                        systemImage: "doc.text.viewfinder",
                        description: Text("Tap Scan to photograph a receipt.")
                    )
                } else {
                    ForEach(uploads) { upload in
                        UploadRow(upload: upload)
                    }
                    .onDelete(perform: deleteUploads)
                }
            }
            .navigationTitle("Receipts")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    serverBadge
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !syncedUploads.isEmpty {
                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            Image(systemName: "trash")
                        }
                    }
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gear")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                bottomBar
            }
        }
        .sheet(isPresented: $showScanner) {
            ScannerView(onScan: handleScan, onCancel: { showScanner = false })
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(server: server)
        }
        .confirmationDialog(
            "Delete \(syncedUploads.count) synced receipt\(syncedUploads.count == 1 ? "" : "s")?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { deleteSynced() }
        } message: {
            Text("These receipts have been uploaded to your Mac. They will be removed from this device.")
        }
        .alert("Sync Error", isPresented: .constant(syncError != nil)) {
            Button("OK") { syncError = nil }
        } message: {
            Text(syncError ?? "")
        }
        .onAppear { server.start() }
        .onDisappear { server.stop() }
    }

    // MARK: - Subviews

    private var serverBadge: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(server.serverURL != nil ? Color.green : Color.secondary.opacity(0.4))
                .frame(width: 8, height: 8)
            Text(server.serverURL != nil ? "Server found" : (server.isSearching ? "Searching…" : "No server"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var bottomBar: some View {
        HStack(spacing: 12) {
            Button {
                showScanner = true
            } label: {
                Label(isProcessing ? "Processing…" : "Scan Receipt", systemImage: "doc.text.viewfinder")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isProcessing)

            if server.serverURL != nil {
                Button {
                    guard let url = server.serverURL else { return }
                    Task { await syncAll(to: url) }
                } label: {
                    if isSyncing {
                        HStack(spacing: 6) {
                            ProgressView().scaleEffect(0.75)
                            Text("\(syncProgress.done)/\(syncProgress.total)")
                        }
                        .frame(maxWidth: .infinity)
                    } else {
                        Label("Sync \(pendingUploads.count)", systemImage: "arrow.up.circle")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.bordered)
                .disabled(isSyncing || pendingUploads.isEmpty)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
        .background(.regularMaterial)
    }

    // MARK: - Actions

    private func handleScan(_ images: [UIImage]) {
        showScanner = false
        isProcessing = true

        Task.detached(priority: .userInitiated) {
            guard let pdfData = PDFCreator.createPDF(from: images) else {
                await MainActor.run { isProcessing = false }
                return
            }

            let capturedAt = Date()
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyyMMdd-HHmmss"
            let filename = "\(formatter.string(from: capturedAt)).pdf"

            let docsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let fileURL = docsDir.appendingPathComponent(filename)

            do {
                try pdfData.write(to: fileURL)
                await MainActor.run {
                    let upload = PendingUpload(filename: filename, capturedAt: capturedAt, pageCount: images.count)
                    modelContext.insert(upload)
                    isProcessing = false
                }
            } catch {
                await MainActor.run { isProcessing = false }
            }
        }
    }

    private func syncAll(to serverURL: URL) async {
        let pending = uploads.filter { !$0.synced }
        guard !pending.isEmpty else { return }

        isSyncing = true
        syncProgress = (0, pending.count)
        syncError = nil

        for upload in pending {
            do {
                try await UploadService.upload(upload, to: serverURL)
                upload.synced = true
                syncProgress.done += 1
                try? modelContext.save()
            } catch {
                syncError = error.localizedDescription
                break
            }
        }

        isSyncing = false
    }

    private func deleteUploads(at offsets: IndexSet) {
        let fm = FileManager.default
        for index in offsets {
            let upload = uploads[index]
            try? fm.removeItem(at: upload.fileURL)
            modelContext.delete(upload)
        }
        try? modelContext.save()
    }

    private func deleteSynced() {
        let fm = FileManager.default
        for upload in syncedUploads {
            try? fm.removeItem(at: upload.fileURL)
            modelContext.delete(upload)
        }
        try? modelContext.save()
    }
}

struct UploadRow: View {
    let upload: PendingUpload

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: upload.synced ? "checkmark.circle.fill" : "clock.badge.fill")
                .foregroundStyle(upload.synced ? .green : .orange)
                .font(.title3)

            VStack(alignment: .leading, spacing: 2) {
                Text(upload.capturedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.body)
                HStack(spacing: 8) {
                    Text("\(upload.pageCount) page\(upload.pageCount == 1 ? "" : "s")")
                    if let size = upload.fileSize {
                        Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            Text(upload.synced ? "Synced" : "Pending")
                .font(.caption)
                .foregroundStyle(upload.synced ? .green : .orange)
        }
        .padding(.vertical, 2)
    }
}
