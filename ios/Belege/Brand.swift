import SwiftUI
import CoreText

/// The Mac app's look on the phone: colours from src/app/styles/tokens.css (asset catalog, light and dark),
/// its fonts (Instrument Sans, Hanken Grotesk, Geist Mono; SIL OFL, licences in Fonts/), and the brand «V».
enum Brand {
    /// The fonts ship as the Mac app's .woff2 files; CoreText reads them, so they are registered at launch
    /// instead of through UIAppFonts.
    static func registerFonts() {
        let urls = (Bundle.main.urls(forResourcesWithExtension: "woff2", subdirectory: nil) ?? [])
            + (Bundle.main.urls(forResourcesWithExtension: "woff2", subdirectory: "Fonts") ?? [])
        guard !urls.isEmpty else { return }
        CTFontManagerRegisterFontURLs(urls as CFArray, .process, true, nil)
    }

    /// The large title «Belege» in Hanken Grotesk, as on the Mac. Only the fonts: the bar keeps the
    /// system's own appearance (on iOS 26 its glass), so the large title stays visible.
    static func applyAppearance() {
        let bar = UINavigationBar.appearance()
        if let large = UIFont(name: "HankenGrotesk-ExtraBold", size: 34) {
            bar.largeTitleTextAttributes = [.font: large, .foregroundColor: UIColor(named: "Ink") ?? .label]
        }
        if let small = UIFont(name: "InstrumentSans-SemiBold", size: 17) {
            bar.titleTextAttributes = [.font: small, .foregroundColor: UIColor(named: "Ink") ?? .label]
        }
    }
}

extension Color {
    static let ink = Color("Ink")
    static let ink2 = Color("Ink2")
    static let muted = Color("Muted")
    static let faint = Color("Faint")
    static let line = Color("Line")
    static let line2 = Color("Line2")
    static let pos = Color("Pos")
    static let warn = Color("Warn")
    static let warnSoft = Color("WarnSoft")
    static let background = Color("Background")
    static let group = Color("Group")
    static let onAccent = Color("OnAccent")
    static let brandBlue = Color("BrandBlue")
    /// The asset itself: Color.accentColor only follows it when the build names it (ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME).
    static let accent = Color("AccentColor")
}

extension Font {
    /// Text: Instrument Sans, scaling with Dynamic Type from the given text style.
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        let name: String
        switch weight {
        case .semibold, .bold, .heavy, .black: name = "InstrumentSans-SemiBold"
        case .medium: name = "InstrumentSans-Medium"
        default: name = "InstrumentSans-Regular"
        }
        return .custom(name, size: size, relativeTo: style)
    }

    /// Headings: Hanken Grotesk.
    static func head(_ size: CGFloat, relativeTo style: Font.TextStyle = .title) -> Font {
        .custom("HankenGrotesk-ExtraBold", size: size, relativeTo: style)
    }

    /// Times, sizes and amounts: Geist Mono.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .footnote) -> Font {
        .custom(weight == .regular ? "GeistMono-Regular" : "GeistMono-Medium", size: size, relativeTo: style)
    }
}

/// The brand «V» wave, the path of desktop/icon.svg (from the branding repo, see desktop/brand-icons.json),
/// drawn in its own coordinates and fitted into the given rect.
struct WaveShape: Shape {
    static let d = "M5.275,0.35C5.275,0.35 1.437,0.35 1.437,0.35C0.888,0.35 0.437,0.801 0.437,1.35C0.437,1.468 0.458,1.586 0.499,1.697L9.608,26.302C10.564,28.886 13.042,30.611 15.797,30.611C18.553,30.611 21.031,28.886 21.987,26.302L29.41,6.253C29.555,5.862 29.93,5.601 30.348,5.601C30.765,5.601 31.14,5.862 31.285,6.253L36.133,19.347C36.278,19.739 36.653,20 37.071,20C37.071,20 40.91,20 40.91,20C41.459,20 41.91,19.549 41.91,19C41.91,18.882 41.889,18.764 41.848,18.653L36.537,4.308C35.581,1.724 33.103,-0.001 30.348,-0.001C27.592,-0.001 25.114,1.724 24.158,4.308L16.735,24.357C16.59,24.748 16.215,25.009 15.797,25.009C15.38,25.009 15.005,24.748 14.86,24.357L6.213,1.003C6.068,0.611 5.693,0.35 5.275,0.35Z"
    private static let unit = SVGPath.parse(d)

    func path(in rect: CGRect) -> Path {
        let b = Self.unit.boundingRect
        let scale = min(rect.width / b.width, rect.height / b.height)
        let dx = rect.midX - b.midX * scale
        let dy = rect.midY - b.midY * scale
        return Self.unit.applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: dx, ty: dy))
    }
}

/// The brand badge: the white «V» on the brand blue, as the rounded square of desktop/icon.svg
/// (corner 185.4 of 824, the wave 0.688 of the width).
struct BrandBadge: View {
    var size: CGFloat = 32

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
            .fill(Color.brandBlue)
            .frame(width: size, height: size)
            .overlay(WaveShape().fill(.white).frame(width: size * 0.688, height: size * 0.501))
            .accessibilityLabel("Vanilla")
    }
}

/// Just enough of SVG path data for the brand mark: absolute M, L, C and Z.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var numbers: [CGFloat] = []
        var command: Character = " "
        func flush() {
            switch command {
            case "M": if numbers.count >= 2 { path.move(to: CGPoint(x: numbers[0], y: numbers[1])) }
            case "L": if numbers.count >= 2 { path.addLine(to: CGPoint(x: numbers[0], y: numbers[1])) }
            case "C":
                var i = 0
                while i + 5 < numbers.count {
                    path.addCurve(to: CGPoint(x: numbers[i + 4], y: numbers[i + 5]),
                                  control1: CGPoint(x: numbers[i], y: numbers[i + 1]),
                                  control2: CGPoint(x: numbers[i + 2], y: numbers[i + 3]))
                    i += 6
                }
            case "Z": path.closeSubpath()
            default: break
            }
            numbers = []
        }
        var token = ""
        func endNumber() { if let v = Double(token) { numbers.append(CGFloat(v)) }; token = "" }
        for ch in d {
            if "MLCZ".contains(ch) {
                endNumber(); flush(); command = ch
            } else if ch == "," || ch == " " {
                endNumber()
            } else if ch == "-" && !token.isEmpty {
                endNumber(); token = "-"
            } else {
                token.append(ch)
            }
        }
        endNumber(); flush()
        return path
    }
}

/// Who uses this phone: an email, asked once at pairing. It is the label shown for the phone and the
/// accountant's contact address; it is not verified. Stored once per phone, never on a receipt: phase 4
/// registers it with the Mac's list of paired phones, uploads are attributed by the phone's own token,
/// and a receipt only references the phone (docs/0.4.0/mockups/phone-app/NOTES.md «Who uploaded it»).
/// Phase 1 keeps it on the phone.
enum PhonePerson {
    static let emailKey = "uploaderEmail"

    /// Where space is tight: the part before the @ («anna.muster»).
    static func short(_ email: String) -> String {
        email.split(separator: "@", maxSplits: 1).first.map(String.init) ?? email
    }

    /// Plausible enough to go on: something@something.tld. A typo still passes; verifying it (a one-time
    /// code by email) is for later.
    static func looksLikeEmail(_ s: String) -> Bool {
        s.range(of: #"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"#, options: .regularExpression) != nil
    }
}

/// The official lockup (wave and «VANILLA AI / ACCOUNTING»), outlined, from the branding repo; light and dark
/// versions in the asset catalog. Shown in the top bar by the brand owner's decision (the app lives on its own
/// on the phone, without the Mac app's start screen).
struct BrandLockup: View {
    var height: CGFloat = 26

    var body: some View {
        Image("BrandLockup")
            .resizable()
            .scaledToFit()
            .frame(height: height)
            .accessibilityLabel("Vanilla AI Accounting")
    }
}

/// The app's own icon, as the home screen shows it (for Settings › Über).
enum AppIconImage {
    static var image: UIImage? {
        guard let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any],
              let primary = icons["CFBundlePrimaryIcon"] as? [String: Any],
              let files = primary["CFBundleIconFiles"] as? [String],
              let name = files.last else { return nil }
        return UIImage(named: name)
    }
}
