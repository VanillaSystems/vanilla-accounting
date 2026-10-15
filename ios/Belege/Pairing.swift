import Foundation
import Security

/// What the Mac's pairing code (Firma › Handy) carries: `http://<address>:<port>/scan#token=<token>`.
/// The server is the URL without its path; the token goes with every request as `Authorization: Bearer`.
struct Pairing: Equatable {
    let serverURL: URL
    let token: String

    init?(code: String) {
        guard let parts = URLComponents(string: code.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "http" || parts.scheme == "https",
              let host = parts.host, !host.isEmpty,
              let fragment = parts.fragment,
              let token = URLComponents(string: "?" + fragment)?.queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty else { return nil }
        var server = URLComponents()
        server.scheme = parts.scheme
        server.host = host
        server.port = parts.port
        guard let url = server.url else { return nil }
        self.serverURL = url
        self.token = token
    }

    init(serverURL: URL, token: String) {
        self.serverURL = serverURL
        self.token = token
    }
}

/// The token is a secret: it lives in the Keychain, readable only by this app on this device.
enum TokenStore {
    private static let service = "com.belege.receipts.pairing"
    private static let account = "token"

    static func load() -> String? {
        var item: CFTypeRef?
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) {
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(match as CFDictionary)
        var add = match
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

extension URLRequest {
    mutating func authorize(_ token: String?) {
        if let token, !token.isEmpty { setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    }
}
