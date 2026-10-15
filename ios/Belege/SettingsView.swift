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

    enum TestResult {
        case success, failure(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                // MARK: Pairing
                Section {
                    if PairingScannerView.isAvailable {
                        Button {
                            showPairingScanner = true
                        } label: {
                            Label("Scan the code on the Mac", systemImage: "qrcode.viewfinder")
                        }
                    }
                    TextField("or paste the pairing link", text: $codeInput)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .onSubmit { pair(codeInput) }
                    if !codeInput.isEmpty {
                        Button("Pair") { pair(codeInput) }
                    }
                    if pairingFailed {
                        Text("That is no pairing code of Vanilla Accounting.").font(.caption).foregroundStyle(.red)
                    }
                } header: {
                    Text("Pair with Mac")
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
                            Text("Test & Save")
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
                    Text("Server URL")
                } footer: {
                    if let url = server.serverURL {
                        Label("Connected to \(url.host ?? url.absoluteString)", systemImage: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }

                // MARK: Setup Instructions
                Section("Setup") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("In Vanilla Accounting on the Mac, open Firma › Handy and switch it on. Then scan the code it shows.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Text("Make sure your iPhone and Mac are on the same Wi-Fi network.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Text("Developers running npm start: set VANILLA_PHONE_TOKEN in .env; the terminal prints the pairing link.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                urlInput = server.storedURLString
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

    private var pairingFooter: String {
        switch server.state {
        case .connected: return "Connected to \(server.serverURL?.host ?? "the Mac")."
        case .notPaired: return "The Mac refused this phone: scan its code again (it may have made a new one)."
        default: return "The code holds the Mac's address and a key only paired phones know."
        }
    }

    private func pair(_ code: String) {
        pairingFailed = !server.pair(code: code)
        if !pairingFailed {
            codeInput = ""
            urlInput = server.storedURLString
        }
    }

    private func testConnection() async {
        isTesting = true
        testResult = nil

        let urlStr = urlInput.trimmingCharacters(in: .whitespaces)
        guard !urlStr.isEmpty,
              let _ = URL(string: urlStr),
              let statusURL = URL(string: urlStr.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/status") else {
            testResult = .failure("Invalid URL")
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
                testResult = .failure("Not paired: scan the code on the Mac")
            } else {
                testResult = .failure("Server responded with an error")
            }
        } catch {
            testResult = .failure(error.localizedDescription)
        }

        isTesting = false
    }
}
