// Pages from Photos for the document scanner (`galleryImport: true`; ML Kit's import button on Android). VisionKit's
// camera has no import, so the plugin asks first (Camera / Photos, an action sheet), or goes straight here when there
// is no document camera (the simulator). PHPicker needs no Photos permission.
//
// Each photo, one at a time off the main thread: read at most DocScanRules.maxSide on its long side (its EXIF turn
// applied), Vision finds the paper (its document segmentation, else its rectangle finder), Core Image straightens it
// (perspective correction), and
// unless `mode` is "base" its document filter evens the light and sharpens the text. A photo where Vision finds no
// paper stays whole. The pages then go to the camera's own answer (files, job, launch), so JS sees the same result.
import CoreImage
import CoreImage.CIFilterBuiltins
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import Vision

@MainActor final class DocScanImport: NSObject, PHPickerViewControllerDelegate {
    private let mode: DocScanRules.Mode
    private var done: (([UIImage]?) -> Void)?
    nonisolated private static let queue = DispatchQueue(label: "zn-docscan-import")
    nonisolated private static let context = CIContext()

    private init(_ mode: DocScanRules.Mode, _ done: @escaping ([UIImage]?) -> Void) {
        self.mode = mode
        self.done = done
    }

    /// Opens the picker over [top]. [done] gets the pages, or nil when the user cancelled or nothing could be read.
    /// Keep the returned object until then.
    static func present(from top: UIViewController, options: DocScanRules.Options, done: @escaping ([UIImage]?) -> Void) -> DocScanImport {
        let me = DocScanImport(options.mode, done)
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = DocScanRules.pickLimit(options.pageLimit)
        config.selection = .ordered  // pages in the order the user tapped them
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = me
        picker.modalPresentationStyle = .fullScreen  // a swipe down would close it with no answer
        top.present(picker, animated: true)
        return me
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let providers = results.map(\.itemProvider)
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            guard !providers.isEmpty else { return finish(nil) }
            let mode = self.mode
            Self.queue.async {
                let pages = Self.pages(providers, mode)
                DispatchQueue.main.async { self.finish(pages.isEmpty ? nil : pages) }
            }
        }
    }

    private func finish(_ pages: [UIImage]?) {
        let d = done
        done = nil
        d?(pages)
    }

    // MARK: Off the main thread (the import queue)

    nonisolated private static func pages(_ providers: [NSItemProvider], _ mode: DocScanRules.Mode) -> [UIImage] {
        var out: [UIImage] = []
        for (i, p) in providers.enumerated() {
            autoreleasepool {
                guard let photo = read(p) else { return print("zn docscanner: photo \(i + 1) can't be read; left out") }
                if let page = page(photo, mode) { out.append(page) }
            }
        }
        print("zn docscanner: \(out.count) of \(providers.count) photos made into pages (mode \(mode.rawValue))")
        return out
    }

    /// The photo as a picture, its EXIF turn applied, at most maxSide pixels on its long side. Waits for the provider.
    nonisolated private static func read(_ provider: NSItemProvider) -> CGImage? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { return nil }
        let wait = DispatchSemaphore(value: 0)
        var picture: CGImage?
        // The file is there only inside the callback: read it at once.
        provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
            defer { wait.signal() }
            guard let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return }
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: DocScanRules.maxSide,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            picture = CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
        }
        wait.wait()
        return picture
    }

    /// The paper in the photo: Vision's document segmentation (a model; it finds nothing on the simulator), else its
    /// plain rectangle finder. nil when neither is sure.
    nonisolated private static func paper(_ photo: CGImage) -> VNRectangleObservation? {
        let handler = VNImageRequestHandler(cgImage: photo, options: [:])
        let document = VNDetectDocumentSegmentationRequest()
        let rectangle = VNDetectRectanglesRequest()
        rectangle.maximumObservations = 1
        rectangle.minimumSize = 0.2
        rectangle.minimumAspectRatio = 0.2
        rectangle.quadratureTolerance = 30
        for (name, request) in [("document", document), ("rectangle", rectangle)] as [(String, VNImageBasedRequest)] {
            do {
                try handler.perform([request])
            } catch {
                print("zn docscanner: Vision's \(name) finder failed (\((error as NSError).code))")
                continue
            }
            if let found = (request.results as? [VNRectangleObservation])?.first, DocScanRules.useCorners(found.confidence) {
                print("zn docscanner: paper found by Vision's \(name) finder (\(found.confidence))")
                return found
            }
        }
        print("zn docscanner: no paper found; the whole photo is the page")
        return nil
    }

    /// One page: the paper straightened when Vision finds it, then the document filter unless the mode is "base".
    nonisolated private static func page(_ photo: CGImage, _ mode: DocScanRules.Mode) -> UIImage? {
        var image = CIImage(cgImage: photo)
        if let paper = paper(photo) {
            let w = Double(photo.width), h = Double(photo.height)
            let c = DocScanRules.corners([paper.topLeft, paper.topRight, paper.bottomRight, paper.bottomLeft].map { (Double($0.x), Double($0.y)) },
                                         width: w, height: h).map { CGPoint(x: $0.0, y: $0.1) }
            let f = CIFilter.perspectiveCorrection()
            f.inputImage = image
            f.topLeft = c[0]
            f.topRight = c[1]
            f.bottomRight = c[2]
            f.bottomLeft = c[3]
            if let straight = f.outputImage { image = straight }
        }
        if DocScanRules.enhance(mode) {
            let f = CIFilter.documentEnhancer()
            f.inputImage = image
            f.amount = 1
            if let clean = f.outputImage { image = clean }
        }
        let extent = image.extent.integral
        guard !extent.isEmpty, let out = context.createCGImage(image, from: extent) else { return nil }
        // Kept as JPEG data, so 100 pages don't wait decoded in memory for the files to be written.
        let ui = UIImage(cgImage: out)
        return ui.jpegData(compressionQuality: 0.95).flatMap { UIImage(data: $0) } ?? ui
    }
}
