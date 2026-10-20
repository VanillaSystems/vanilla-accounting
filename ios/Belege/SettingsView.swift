import SwiftUI

struct SettingsView: View {
    @ObservedObject var server: ServerConnection
    @Environment(\.dismiss) private var dismiss

    @State private var urlInput: String = ""
    @State private var isTesting = false
    @State private var testResult: TestResult?
    @State private var showPairingScanner = false
    @State private var codeInput: String = ""
    @State private var pairingFailed = false
    /// This phone's person (see PhonePerson). Phase 1 keeps it on the phone.
    @AppStorage(PhonePerson.emailKey) private var uploaderEmail = ""
    @State private var showNameStep = false // the email step
    @AppStorage("autoDeleteSentAfter30Days") private var autoDeleteSent = false

    enum TestResult {
        case success, failure(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 10) {
                        BrandLockup(height: 40)
                        Text("by Vanilla Machines").font(.sans(12.5, relativeTo: .caption)).foregroundStyle(Color.muted)
                            .padding(.bottom, 8)
                        Text("Mit dem Mac verbinden").font(.head(22, relativeTo: .title2)).foregroundStyle(Color.ink)
                        Text("Am Mac: Firma › Handy öffnen und einschalten. Dann den Code scannen.")
                            .font(.sans(14))
                            .foregroundStyle(Color.ink2)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                // MARK: Who takes the receipts
                Section {
                    TextField("anna.muster@firma.ch", text: $uploaderEmail)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.sans(16))
                } header: {
                    Text("Deine E-Mail")
                } footer: {
                    Text("Steht bei deinen Belegen, damit die Buchhaltung weiss, wen sie fragen kann, und wie sie dich erreicht. Vorerst nur auf diesem Handy; an den Mac geht sie mit einem nächsten Update.")
                }

                // MARK: Sent receipts
                Section {
                    Toggle("Gesendete nach 30 Tagen vom Handy löschen", isOn: $autoDeleteSent)
                        .font(.sans(16))
                } footer: {
                    Text("Sie bleiben auf dem Mac. Ohne diese Einstellung bleiben sie auf dem Handy, bis du sie unter «Gesendet» löschst.")
                }

                // MARK: Pairing
                Section {
                    if PairingScannerView.isAvailable {
                        Button {
                            showPairingScanner = true
                        } label: {
                            Label("Code am Mac scannen", systemImage: "qrcode.viewfinder")
                        }
                    }
                    TextField("oder den Koppel-Link einfügen", text: $codeInput)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .onSubmit { pair(codeInput) }
                    if !codeInput.isEmpty {
                        Button("Koppeln") { pair(codeInput) }
                    }
                    if pairingFailed {
                        Text("Das ist kein Koppel-Code von Vanilla Accounting.").font(.caption).foregroundStyle(.red)
                    }
                } header: {
                    Text("Mit dem Mac koppeln")
                } footer: {
                    Text(pairingFooter).font(.caption)
                }

                // MARK: Server URL
                Section {
                    TextField("http://192.168.0.10:3456", text: $urlInput)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)

                    Button {
                        Task { await testConnection() }
                    } label: {
                        HStack {
                            Text("Prüfen und sichern")
                            Spacer()
                            if isTesting {
                                ProgressView()
                            } else if let result = testResult {
                                switch result {
                                case .success:
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                                case .failure:
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                                }
                            }
                        }
                    }
                    .disabled(urlInput.isEmpty || isTesting)

                    if case .failure(let msg) = testResult {
                        Text(msg).font(.caption).foregroundStyle(.red)
                    }
                } header: {
                    Text("Adresse des Macs (von Hand)")
                } footer: {
                    if let url = server.serverURL {
                        Label("Verbunden mit \(url.host ?? url.absoluteString)", systemImage: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }

                // MARK: Setup Instructions (the «Über» section follows below)
                Section("So geht's") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Am Mac in Vanilla Accounting Firma › Handy öffnen und einschalten. Dann den Code scannen, den er zeigt.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Text("iPhone und Mac müssen im selben WLAN sein.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Text("Für Entwickler mit npm start: VANILLA_PHONE_TOKEN in .env setzen; das Terminal zeigt den Koppel-Link.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                // MARK: About
                Section("Über") {
                    HStack(spacing: 14) {
                        if let icon = AppIconImage.image {
                            Image(uiImage: icon).resizable().frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 12.5, style: .continuous))
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Vanilla Belege").font(.sans(17, .semibold)).foregroundStyle(Color.ink)
                            Text(versionText).font(.mono(12.5)).foregroundStyle(Color.ink2)
                            Text("Teil von Vanilla AI Accounting · by Vanilla Machines").font(.sans(12.5)).foregroundStyle(Color.muted)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle("Einstellungen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
            }
            .onAppear {
                urlInput = server.storedURLString
            }
            .sheet(isPresented: $showNameStep) {
                EmailStepView(email: $uploaderEmail)
            }
            .sheet(isPresented: $showPairingScanner) {
                PairingScannerView { code in
                    showPairingScanner = false
                    pair(code)
                }
                .ignoresSafeArea()
            }
        }
    }

    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Version \(version) (\(build))"
    }

    private var pairingFooter: String {
        switch server.state {
        case .connected: return "Verbunden mit \(server.serverURL?.host ?? "dem Mac")."
        case .notPaired: return "Der Mac hat dieses Handy abgelehnt: den Code nochmals scannen (er hat vielleicht einen neuen erstellt)."
        default: return "Der Code enthält die Adresse des Macs und einen Schlüssel, den nur gekoppelte Handys kennen."
        }
    }

    private func pair(_ code: String) {
        pairingFailed = !server.pair(code: code)
        if !pairingFailed {
            codeInput = ""
            urlInput = server.storedURLString
            if uploaderEmail.trimmingCharacters(in: .whitespaces).isEmpty { showNameStep = true }
        }
    }

    private func testConnection() async {
        isTesting = true
        testResult = nil

        let urlStr = urlInput.trimmingCharacters(in: .whitespaces)
        guard !urlStr.isEmpty,
              let _ = URL(string: urlStr),
              let statusURL = URL(string: urlStr.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/status") else {
            testResult = .failure("Keine gültige Adresse")
            isTesting = false
            return
        }

        do {
            var req = URLRequest(url: statusURL, timeoutInterval: 5)
            req.httpMethod = "GET"
            req.authorize(server.token)
            let (_, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode
            if status == 200 {
                testResult = .success
                server.tryManualURL(urlStr)
            } else if status == 401 {
                testResult = .failure("Nicht gekoppelt: den Code am Mac scannen")
            } else {
                testResult = .failure("Der Mac hat mit einem Fehler geantwortet")
            }
        } catch {
            testResult = .failure(error.localizedDescription)
        }

        isTesting = false
    }
}

/// Right after pairing: how the accountant reaches this phone's person. One field, the email;
/// «Später» leaves it for Settings.
struct EmailStepView: View {
    @Binding var email: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var plausible: Bool { PhonePerson.looksLikeEmail(draft.trimmingCharacters(in: .whitespaces)) }

    var body: some View {
        VStack(spacing: 14) {
            BrandBadge(size: 52).padding(.top, 32)
            Text("Verbunden.").font(.head(24, relativeTo: .title2)).foregroundStyle(Color.ink)
            Text("Wie erreicht dich die Buchhaltung bei Fragen?")
                .font(.sans(16, .medium)).foregroundStyle(Color.ink).multilineTextAlignment(.center)
            Text("Die E-Mail steht bei deinen Belegen, damit die Buchhaltung weiss, wen sie fragen kann.")
                .font(.sans(14)).foregroundStyle(Color.ink2).multilineTextAlignment(.center)
            TextField("anna.muster@firma.ch", text: $draft)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.sans(17))
                .padding(12)
                .background(Color.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.accent, lineWidth: 1.5))
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(save)
            Spacer()
            Button(action: save) {
                Text("Weiter").font(.sans(17, .semibold))
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .foregroundStyle(Color.onAccent)
                    .background(Color.accent.opacity(plausible ? 1 : 0.4), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .disabled(!plausible)
            Button("Später") { dismiss() }.font(.sans(15)).foregroundStyle(Color.muted)
        }
        .padding(24)
        .background(Color.background)
        .onAppear { draft = email; focused = true }
    }

    private func save() {
        guard plausible else { return }
        email = draft.trimmingCharacters(in: .whitespaces)
        dismiss()
    }
}
