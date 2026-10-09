import UIKit

enum PDFCreator {
    /// Target ~2MP per page, JPEG quality 75%
    private static let maxPixels = 2_000_000
    private static let jpegQuality: CGFloat = 0.75

    static func createPDF(from images: [UIImage]) -> Data? {
        let pdfData = NSMutableData()
        UIGraphicsBeginPDFContextToData(pdfData, .zero, nil)

        for image in images {
            let compressed = compress(image)
            // Use 72 DPI equivalent sizing (points = pixels at 1x)
            let size = CGSize(
                width: compressed.size.width / compressed.scale,
                height: compressed.size.height / compressed.scale
            )
            UIGraphicsBeginPDFPageWithInfo(CGRect(origin: .zero, size: size), nil)
            compressed.draw(in: CGRect(origin: .zero, size: size))
        }

        UIGraphicsEndPDFContext()
        return (pdfData as Data).isEmpty ? nil : (pdfData as Data)
    }

    private static func compress(_ image: UIImage) -> UIImage {
        let w = image.size.width * image.scale
        let h = image.size.height * image.scale
        let pixels = Int(w * h)

        let targetImage: UIImage
        if pixels > maxPixels {
            let scale = sqrt(Double(maxPixels) / Double(pixels))
            let newSize = CGSize(width: w * scale, height: h * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            targetImage = renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: newSize))
            }
        } else {
            targetImage = image
        }

        if let data = targetImage.jpegData(compressionQuality: jpegQuality),
           let reencoded = UIImage(data: data) {
            return reencoded
        }
        return targetImage
    }
}
