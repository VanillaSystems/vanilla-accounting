import SwiftUI

struct SettingsView: View {
    @ObservedObject var server: ServerConnection
    @Environment(\.dismiss) private var dismiss

    @State private var urlInput: String = ""
    @State private var isTesting = false
    @State private var testResult: TestResult?

    enum TestResult {
        case success, failure(String)
    }

    var body: some View {
        NavigationStack {
            Form {
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
                        Text("On your Mac, open a terminal in the project folder and run:")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Text("npm start")
                            .font(.system(.caption, design: .monospaced))
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 6))

                        Text("The terminal will show the server's IP addresses. Enter one of them above (e.g. http://192.168.0.10:3456).")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Text("Make sure your iPhone and Mac are on the same Wi-Fi network.")
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
            let (_, resp) = try await URLSession.shared.data(for: req)
            if (resp as? HTTPURLResponse)?.statusCode == 200 {
                testResult = .success
                server.tryManualURL(urlStr)
            } else {
                testResult = .failure("Server responded with an error")
            }
        } catch {
            testResult = .failure(error.localizedDescription)
        }

        isTesting = false
    }
}
