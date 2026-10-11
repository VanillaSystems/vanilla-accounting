import Foundation

@MainActor
final class ServerConnection: ObservableObject {
    @Published var serverURL: URL?
    @Published var isSearching = false

    // Persisted across launches
    var storedURLString: String {
        get { UserDefaults.standard.string(forKey: "serverURLString") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "serverURLString") }
    }

    func start() {
        guard let url = URL(string: storedURLString), !storedURLString.isEmpty else { return }
        Task { await ping(url) }
    }

    func stop() {}

    /// Called from SettingsView when the user enters a URL.
    func tryManualURL(_ urlString: String) {
        storedURLString = urlString
        guard let url = URL(string: urlString) else { return }
        Task { await ping(url) }
    }

    private func ping(_ url: URL) async {
        isSearching = true
        defer { isSearching = false }
        let base = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let statusURL = URL(string: base + "/api/status") else { return }
        do {
            var req = URLRequest(url: statusURL, timeoutInterval: 5)
            req.httpMethod = "GET"
            let (_, resp) = try await URLSession.shared.data(for: req)
            if (resp as? HTTPURLResponse)?.statusCode == 200 {
                serverURL = url
                storedURLString = url.absoluteString
            }
        } catch {}
    }
}
