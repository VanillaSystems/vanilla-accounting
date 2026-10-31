import SwiftUI
import SwiftData

@main
struct BelegeApp: App {
    init() {
        Brand.registerFonts()
        Brand.applyAppearance()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: PendingUpload.self)
    }
}
