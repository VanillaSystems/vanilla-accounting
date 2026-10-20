import Foundation
import PDFKit
import UIKit
import Vision

/// Apple's on-device text recognition on a receipt's first page, offline. One pass gives the lines for
/// ReceiptNaming and the receipt's header (the top of the printed content) for the list's tile.
enum ReceiptRecognizer {
    struct Result {
        let lines: [String]
        /// The top band of the content, cropped from page 1; nil when no text was found there.
        let header: UIImage?
    }

    static func analyze(pdf url: URL) -> Result {
        guard let page = firstPage(of: url) else { return Result(lines: [], header: nil) }
        let observations = recognize(page)
        let lines = observations
            .sorted { $0.boundingBox.midY > $1.boundingBox.midY }   // Vision's origin is bottom left
            .compactMap { $0.topCandidates(1).first?.string }
        return Result(lines: lines, header: header(of: page, from: observations))
    }

    private static func recognize(_ image: CGImage) -> [VNRecognizedTextObservation] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["de-DE", "fr-FR", "it-IT", "en-US"]
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        guard (try? handler.perform([request])) != nil else { return [] }
        return request.results ?? []
    }

    /// From the topmost text down about 28 % of the content's height, as wide as the text in that band,
    /// with a small margin. The blank margins of the scan fall away.
    private static func header(of image: CGImage, from observations: [VNRecognizedTextObservation]) -> UIImage? {
        guard !observations.isEmpty else { return nil }
        let top = observations.map { $0.boundingBox.maxY }.max()!
        let bottom = observations.map { $0.boundingBox.minY }.min()!
        let bandBottom = top - max(0.12, (top - bottom) * 0.28)
        let band = observations.filter { $0.boundingBox.midY >= bandBottom }
        guard !band.isEmpty else { return nil }
        let minX = band.map { $0.boundingBox.minX }.min()!
        let maxX = band.map { $0.boundingBox.maxX }.max()!
        let w = CGFloat(image.width), h = CGFloat(image.height)
        let margin: CGFloat = 0.02
        var rect = CGRect(
            x: (minX - margin) * w,
            y: (1 - top - margin) * h,
            width: (maxX - minX + 2 * margin) * w,
            height: (top - bandBottom + 2 * margin) * h
        ).intersection(CGRect(x: 0, y: 0, width: w, height: h))
        rect = rect.integral
        guard rect.width > 20, rect.height > 10, let crop = image.cropping(to: rect) else { return nil }
        // Small enough for a list tile, sharp enough on a 3x screen.
        let targetWidth: CGFloat = min(480, rect.width)
        let size = CGSize(width: targetWidth, height: rect.height * targetWidth / rect.width)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            UIImage(cgImage: crop).draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// Page 1 drawn on white at about 1600 pixels wide, enough for small receipt print.
    static func firstPage(of url: URL) -> CGImage? {
        let doc = PDFDocument(url: url)
        return withExtendedLifetime(doc) {
            guard let page = doc?.page(at: 0) else { return nil }
            let box = page.bounds(for: .mediaBox)
            guard box.width > 0, box.height > 0 else { return nil }
            let scale = 1600 / box.width
            let size = CGSize(width: box.width * scale, height: box.height * scale)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
                UIColor.white.setFill()
                ctx.fill(CGRect(origin: .zero, size: size))
                ctx.cgContext.translateBy(x: 0, y: size.height)
                ctx.cgContext.scaleBy(x: scale, y: -scale)
                page.draw(with: .mediaBox, to: ctx.cgContext)
            }
            return image.cgImage
        }
    }
}
