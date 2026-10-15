import Foundation

@MainActor
final class ServerConnection: ObservableObject {
    enum State: Equatable { case unknown, searching, connected, notPaired, unreachable }

    @Published var serverURL: URL?
    @Published private(set) var state: State = .unknown

    var isSearching: Bool { state == .searching }

    // Persisted across launches; the token is in the Keychain (TokenStore).
    var storedURLString: String {
        get { UserDefaults.standard.string(forKey: "serverURLString") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "serverURLString") }
    }

    var token: String? { TokenStore.load() }

    func start() {
        guard let url = URL(string: storedURLString), !storedURLString.isEmpty else { return }
        Task { await ping(url) }
    }

    func stop() {}

    /// The Mac's pairing code, scanned or pasted: kept, then checked. False when it is no pairing code.
    func pair(code: String) -> Bool {
        guard let pairing = Pairing(code: code) else { return false }
        TokenStore.save(pairing.token)
        storedURLString = pairing.serverURL.absoluteString
        Task { await ping(pairing.serverURL) }
        return true
    }

    /// Called from SettingsView when the user enters a URL by hand.
    func tryManualURL(_ urlString: String) {
        storedURLString = urlString
        guard let url = URL(string: urlString) else { return }
        Task { await ping(url) }
    }

    private func ping(_ url: URL) async {
        state = .searching
        serverURL = nil
        let base = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let statusURL = URL(string: base + "/api/status") else { state = .unreachable; return }
        var req = URLRequest(url: statusURL, timeoutInterval: 5)
        req.httpMethod = "GET"
        req.authorize(token)
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            switch (resp as? HTTPURLResponse)?.statusCode {
            case 200:
                serverURL = url
                state = .connected
            case 401:
                state = .notPaired
            default:
                state = .unreachable
            }
        } catch {
            state = .unreachable
        }
    }
}
