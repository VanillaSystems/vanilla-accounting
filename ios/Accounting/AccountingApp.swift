import SwiftUI
import SwiftData

@main
struct AccountingApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: PendingUpload.self)
    }
}
