// The image viewer's iOS side (plugins/image-viewer, as android/.../ImageViewerScreen.kt, ViewerRules.kt, ViewerSpec.kt
// and ViewerHeld.kt): the native screen "imageviewer.full" (pictures with pinch zoom, pan, double tap, swipes between
// pictures and up or down to close) and the "ImageViewer" module (v3: hold, release). The same params, answer ({ index })
// and rules as Android.
//
// iOS differences:
// - This screen decodes each picture once with ImageIO (EXIF turns applied, mirror images too), at most 4096 pixels on
//   the long side: a 5000 × 3333 photo is a little soft at 5x, where Android decodes the visible part again at full
//   size. The TSX viewer's page does cut sharp parts (ViewerSource.swift).
// - `content://` links are Android's: refused here (the error shows). `file://` must be inside the app's own folder.
// - No edge swipe back: the route is a fade screen, and ZnNavHost's back swipe is only for screens that slid in (an
//   iOS modal closes with its own button). It closes with the back arrow or a drag up or down, both answering
//   { index }, as on Android. A left-edge swipe pages back, as in Photos.
// - ZeroBill is portrait only, so turning the phone does nothing; the pages lay out again only when the size changes
//   (laying out again at the same size used to reset the pager while it slid, skipping a page).
// - Version 3's TSX viewer (a route with `screen: ImageViewerScreen`, src/ImageViewerScreen.tsx) draws each photo with
//   the view "imageviewer.page" (ViewerPage.swift; rules in ViewerRules.swift, decoding in ViewerSource.swift). A route
//   that still says `native: "imageviewer.full"` (ZeroBill's) gets this screen.
import ImageIO
import UIKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif

public struct ImageViewerPlugin: ZnPlugin {
    public init() {}

    public func register(_ r: ZnPluginRegistry) {
        r.module(ImageViewerModule())
        r.screen("imageviewer.full") { scope in ImageViewerScreen(scope) }
        // Version 3: one picture of the TSX viewer (src/ImageViewerScreen.tsx), moved by useZoom's values.
        r.view("imageviewer.page") { scope in ViewerPage(scope) }
    }
}

/// What JS gave natively for a viewer's pictures: `data:` bytes and request headers, in memory only. The newest 8
/// viewers, 20 MB of pictures in all. Any thread.
enum ViewerHeld {
    struct Held { let bytes: Data?; let headers: [String: String]? }
    private static let lock = NSLock()
    private static var byKey: [(key: String, items: [Int: Held])] = []

    static func get(_ key: String?, _ i: Int) -> Held? {
        guard let key else { return nil }
        return lock.withLock { byKey.first { $0.key == key }?.items[i] }
    }

    static func release(_ key: String) { lock.withLock { byKey.removeAll { $0.key == key } } }

    static func hold(_ key: String, _ items: [[String: Any]]) {
        var out: [Int: Held] = [:]
        var total = 0
        for item in items {
            guard let i = (item["i"] as? NSNumber)?.intValue, i >= 0 else { continue }
            var bytes = (item["data"] as? String).flatMap { decode($0, i) }
            if let b = bytes, total + b.count > ViewerRules.maxHeldBytes {
                print("zn image-viewer: images[\(i)] data: link dropped, over \(ViewerRules.maxHeldBytes / 1048576) MB in all")
                bytes = nil
            }
            total += bytes?.count ?? 0
            var headers: [String: String] = [:]
            for (k, v) in item["headers"] as? [String: Any] ?? [:] {
                guard let v = v as? String else { continue }
                if ViewerRules.safeHeader(k, v) { headers[k] = v } else { print("zn image-viewer: images[\(i)] header \"\(k.prefix(40))\" dropped") }
            }
            out[i] = Held(bytes: bytes, headers: headers.isEmpty ? nil : headers)
        }
        lock.withLock {
            byKey.removeAll { $0.key == key }
            byKey.append((key, out))
            if byKey.count > 8 { byKey.removeFirst(byKey.count - 8) }
            func size() -> Int { byKey.reduce(0) { $0 + $1.items.values.reduce(0) { $0 + ($1.bytes?.count ?? 0) } } }
            while size() > ViewerRules.maxHeldBytes, let i = byKey.firstIndex(where: { $0.key != key }) { byKey.remove(at: i) }
        }
    }

    private static func decode(_ uri: String, _ i: Int) -> Data? {
        guard let start = ViewerRules.dataStart(uri) else {
            print("zn image-viewer: images[\(i)] data: link refused (not a base64 picture, or over 5 MB)")
            return nil
        }
        guard let d = Data(base64Encoded: String(uri[start...]), options: .ignoreUnknownCharacters), !d.isEmpty, d.count <= ViewerRules.maxDataBytes else {
            print("zn image-viewer: images[\(i)] data: link is not valid base64, empty or too big")
            return nil
        }
        return d
    }
}

final class ImageViewerModule: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("ImageViewer", version: 3)
        // Not on the main thread: it decodes base64 (up to 5 MB).
        function("hold") { call in
            guard let key = call.args["key"] as? String, !key.isEmpty, let items = call.args["items"] as? [[String: Any]] else {
                return call.reject("invalid_args", "hold needs key and items")
            }
            ViewerHeld.hold(key, items)
            call.resolve(true)
        }
        // Version 3: the TSX screen frees its held parts when it closes (the bytes and the request headers, tokens).
        function("release") { call in
            if let key = call.args["key"] as? String, !key.isEmpty { ViewerHeld.release(key) }
            call.resolve(true)
        }
    }
}

/// The route's params, read again without trusting them (ViewerSpec.kt).
struct ViewerSpec {
    struct Image { let uri: String; let alt: String?; let held: ViewerHeld.Held? }
    let heldKey: String?
    let images: [Image]
    let index: Int
    let swipeToClose: Bool
    let doubleTap: Bool
    let background: UIColor
    let close, error, retry, photo, next, previous: String

    init(_ p: [String: Any]) {
        func text(_ k: String) -> String? { (p[k] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        heldKey = text("held")
        var list: [Image] = []
        for (i, item) in (p["images"] as? [Any] ?? []).prefix(500).enumerated() {
            guard let o = item as? [String: Any], let uri = o["uri"] as? String, !uri.isEmpty else { continue }
            list.append(Image(uri: uri, alt: (o["alt"] as? String).flatMap { $0.isEmpty ? nil : $0 }, held: ViewerHeld.get(text("held"), i)))
        }
        images = list
        index = min(max((p["index"] as? NSNumber)?.intValue ?? 0, 0), max(0, list.count - 1))
        swipeToClose = p["swipeToClose"] as? Bool ?? true
        doubleTap = p["doubleTap"] as? Bool ?? true
        var bg = UIColor.black
        if let s = text("backgroundColor"), s.hasPrefix("#"), let v = UInt64(s.dropFirst(), radix: 16) {
            let hex = s.dropFirst()
            if hex.count == 6 { bg = UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1) }
            if hex.count == 8 { bg = UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: CGFloat(v >> 24) / 255) }
        }
        background = bg
        close = text("closeLabel") ?? "Close"
        error = text("errorText") ?? "Couldn't load this photo"
        retry = text("retryLabel") ?? "Try again"
        photo = text("photoLabel") ?? "Photo {n} of {count}"
        next = text("nextLabel") ?? "Next photo"
        previous = text("previousLabel") ?? "Previous photo"
    }
}

/// Loads one picture into a UIImage, off the main thread.
enum ViewerLoader {
    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.urlCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 128 << 20)
        c.timeoutIntervalForRequest = 30
        return URLSession(configuration: c)
    }()

    static func load(_ image: ViewerSpec.Image, maxPixels: CGFloat, base: URL?, done: @escaping (UIImage?) -> Void) {
        fetch(image, base: base) { data in
            let img = data.flatMap { downsample($0, maxPixels) }
            DispatchQueue.main.async { done(img) }
        }
    }

    /// The picture's encoded bytes (a file's are mapped, not read), given on a background queue; nil when it can't be
    /// had (an error answer, no such file, a refused link).
    static func fetch(_ image: ViewerSpec.Image, base: URL?, done: @escaping (Data?) -> Void) {
        func give(_ data: @escaping () -> Data?) { DispatchQueue.global(qos: .userInitiated).async { done(data()) } }
        func file(_ url: URL) -> Data? { try? Data(contentsOf: url, options: .mappedIfSafe) }
        let uri = image.uri
        switch ViewerRules.kind(uri) {
        case .web:
            guard let url = URL(string: uri) else { return give { nil } }
            var r = URLRequest(url: url)
            for (k, v) in image.held?.headers ?? [:] { r.setValue(v, forHTTPHeaderField: k) }
            session.dataTask(with: r) { data, response, _ in
                let ok = ((response as? HTTPURLResponse)?.statusCode ?? 0) < 400
                if !ok { print("zn image-viewer: \(url.host ?? "?") answered \((response as? HTTPURLResponse)?.statusCode ?? 0)") }
                done(ok ? data : nil)
            }.resume()
        case .asset:
            guard let path = ViewerRules.assetPath(uri), base != nil else { return give { nil } }
            let url = ZnBundles.assetURL(path)  // the running bundle's copy, else the app's own
            give { file(url) }
        case .file:
            let url = ZnHandles.fileOf(uri)
            give { url.flatMap(file) }
        case .fileUri:
            // Only the app's own folder: a bundle comes over the air, so it may not name any file it likes.
            guard let url = URL(string: uri), url.isFileURL else { return give { nil } }
            let real = url.resolvingSymlinksInPath().standardizedFileURL.path
            let root = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().standardizedFileURL.path
            guard real == root || real.hasPrefix(root + "/") else {
                print("zn image-viewer: a file:// link outside the app's folder refused")
                return give { nil }
            }
            give { file(URL(fileURLWithPath: real)) }
        case .held:
            let bytes = image.held?.bytes
            give { bytes }
        case .content, .refused:
            print("zn image-viewer: link kind not shown on iOS: \(uri.prefix(12))…")
            give { nil }
        }
    }

    /// The picture upright (EXIF applied), at most `maxPixels` on the long side.
    private static func downsample(_ data: Data, _ maxPixels: CGFloat) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// One picture: zoom, pan, double tap; spinner while loading; error and retry.
private final class ZoomPage: UIScrollView, UIScrollViewDelegate {
    let imageView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .medium)  // Android: a small turning white arc
    private let errorStack = ViewerErrorView()
    var onRetry: (() -> Void)?
    /// The zoom changed (the screen stops swipes between pictures while one is zoomed, as Android's pager).
    var onZoom: ((CGFloat) -> Void)?
    var imageSize: CGSize = .zero

    init(spec: ViewerSpec) {
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = ViewerRules.maxZoom
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        decelerationRate = .fast
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        addSubview(imageView)
        spinner.color = .white
        addSubview(spinner)
        errorStack.set(text: spec.error, retry: spec.retry)
        errorStack.onRetry = { [weak self] in self?.onRetry?() }
        errorStack.isHidden = true
        addSubview(errorStack)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func show(loading: Bool, image: UIImage?, failed: Bool) {
        loading ? spinner.startAnimating() : spinner.stopAnimating()
        errorStack.isHidden = !failed
        imageView.image = image
        imageSize = image?.size ?? .zero
        setZoomScale(1, animated: false)
        onZoom?(1)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if zoomScale <= 1.0001 {
            // At zoom 1 the picture fits the page, in the middle.
            let box = bounds.size
            var fit = box
            if imageSize.width > 0, imageSize.height > 0 {
                let s = min(box.width / imageSize.width, box.height / imageSize.height)
                fit = CGSize(width: imageSize.width * s, height: imageSize.height * s)
            }
            imageView.frame = CGRect(origin: .zero, size: fit)
            contentSize = fit
        }
        center()
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        let w = min(bounds.width - 48, 320)
        let h = errorStack.systemLayoutSizeFitting(CGSize(width: w, height: 0)).height
        errorStack.frame = CGRect(x: bounds.midX - w / 2, y: bounds.midY - h / 2, width: w, height: h)
    }

    /// Keeps a picture smaller than the page in its middle.
    private func center() {
        let dx = max(0, (bounds.width - contentSize.width) / 2), dy = max(0, (bounds.height - contentSize.height) / 2)
        contentInset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView.image == nil ? nil : imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        center()
        onZoom?(zoomScale)
    }

    /// Zoomed: back to fit. Not zoomed: 2.5x with the tapped point kept under the finger.
    func doubleTap(at p: CGPoint) {
        guard imageView.image != nil else { return }
        if zoomScale > 1.05 { return setZoomScale(1, animated: true) }
        let point = imageView.convert(p, from: self)
        let size = CGSize(width: bounds.width / ViewerRules.doubleTapZoom, height: bounds.height / ViewerRules.doubleTapZoom)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }
}

/// The screen.
final class ImageViewerScreen: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    private let scope: ZnScreenScope
    private let spec: ViewerSpec
    private let pager = UIScrollView()
    private var pages: [Int: ZoomPage] = [:]
    private var loaded: [Int: UIImage] = [:]
    private var failed = Set<Int>()
    private var loading = Set<Int>()
    private let counter = UILabel()
    /// The bar over the pictures: the close arrow and the count, on a black 55 % → clear fade (Android's, from ZeroBill's
    /// React Native viewer). It fades with the swipe to close.
    private let bar = UIView()
    private let fade = CAGradientLayer()
    private var current: Int
    private var closing = false
    private var drag: CGFloat = 0
    private var laidOut: CGSize = .zero

    init(_ scope: ZnScreenScope) {
        self.scope = scope
        self.spec = ViewerSpec(scope.params)
        self.current = spec.index
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = spec.background
        guard !spec.images.isEmpty else {
            DispatchQueue.main.async { self.scope.cancel() }  // nothing to show: the screen closes
            return
        }
        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.contentInsetAdjustmentBehavior = .never
        pager.delegate = self
        view.addSubview(pager)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.isEnabled = spec.doubleTap
        view.addGestureRecognizer(doubleTap)
        if spec.swipeToClose {
            let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
            pan.delegate = self
            view.addGestureRecognizer(pan)
        }

        // Android's bar: a 56 pt row under the status bar, the white back arrow (24 pt in a 48 pt touch area, no circle)
        // at its start, the count in its middle, over a fade that reaches 24 pt below the row.
        fade.colors = [UIColor.black.withAlphaComponent(0.55).cgColor, UIColor.black.withAlphaComponent(0).cgColor]
        bar.layer.addSublayer(fade)
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)
        let arrow = UIImage(systemName: "arrow.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold))?
            .imageFlippedForRightToLeftLayoutDirection()
        let close = UIButton(type: .system, primaryAction: UIAction { [weak self] _ in self?.closeByUser() })
        close.setImage(arrow, for: .normal)
        close.tintColor = .white
        close.accessibilityLabel = spec.close
        close.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(close)
        counter.textColor = .white
        counter.font = .systemFont(ofSize: 16, weight: .semibold)
        counter.isHidden = spec.images.count < 2
        counter.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(counter)
        let row = UILayoutGuide()
        bar.addLayoutGuide(row)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            row.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            row.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            row.heightAnchor.constraint(equalToConstant: 56),
            bar.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: 24),
            close.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 4),
            close.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            close.widthAnchor.constraint(equalToConstant: 48), close.heightAnchor.constraint(equalToConstant: 48),
            counter.centerXAnchor.constraint(equalTo: row.centerXAnchor),
            counter.centerYAnchor.constraint(equalTo: row.centerYAnchor),
        ])
        bar.accessibilityElements = [close, counter]  // VoiceOver reads the close button and the count first
        updateCounter()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard !spec.images.isEmpty else { return }
        let size = view.bounds.size
        // Only when the size changes (first layout, a turn of the screen). Adding the next page during a swipe runs a
        // layout too, and setting the offset then moved the pager mid-swipe: one swipe went from photo 2 to 4.
        fade.frame = bar.bounds
        guard size != laidOut else { return }
        laidOut = size
        pager.frame = view.bounds
        pager.contentSize = CGSize(width: size.width * CGFloat(spec.images.count), height: size.height)
        pager.contentOffset = CGPoint(x: size.width * CGFloat(current), y: 0)
        for (i, p) in pages { p.frame = CGRect(x: size.width * CGFloat(i), y: 0, width: size.width, height: size.height) }
        showPages()
    }

    // MARK: Pages

    /// The picture on screen and one on each side; the others are let go.
    private func showPages() {
        let size = view.bounds.size
        guard size.width > 0 else { return }
        let want = Set(max(0, current - 1)...min(spec.images.count - 1, current + 1))
        for (i, p) in pages where !want.contains(i) { p.removeFromSuperview(); pages.removeValue(forKey: i) }
        for i in want where pages[i] == nil {
            let p = ZoomPage(spec: spec)
            p.frame = CGRect(x: size.width * CGFloat(i), y: 0, width: size.width, height: size.height)
            p.imageView.accessibilityLabel = spec.images[i].alt ?? ViewerRules.label(spec.photo, i, spec.images.count)
            p.accessibilityCustomActions = [
                UIAccessibilityCustomAction(name: spec.next) { [weak self] _ in self?.go(i + 1) ?? false },
                UIAccessibilityCustomAction(name: spec.previous) { [weak self] _ in self?.go(i - 1) ?? false },
            ]
            p.onRetry = { [weak self] in self?.failed.remove(i); self?.load(i) }
            // Android's pager doesn't swipe while the picture is zoomed: the drag pans the picture to its edge and stops.
            p.onZoom = { [weak self] z in
                guard let self, i == self.current else { return }
                self.pager.isScrollEnabled = z <= ViewerRules.zoomed
            }
            pager.addSubview(p)
            pages[i] = p
            load(i)
        }
    }

    private func load(_ i: Int) {
        guard let page = pages[i] else { return }
        if let img = loaded[i] { return page.show(loading: false, image: img, failed: false) }
        if failed.contains(i) { return page.show(loading: false, image: nil, failed: true) }
        page.show(loading: true, image: nil, failed: false)
        guard !loading.contains(i) else { return }
        loading.insert(i)
        let px = min(ViewerRules.maxPixels, max(view.bounds.width, view.bounds.height) * UIScreen.main.scale * ViewerRules.maxZoom)
        ViewerLoader.load(spec.images[i], maxPixels: px, base: ZnApp.shared.bundleURL) { [weak self] img in
            guard let self else { return }
            self.loading.remove(i)
            if let img { self.loaded[i] = img } else { self.failed.insert(i) }
            // Keep a few decoded pictures only (the ones near the screen).
            for k in self.loaded.keys where abs(k - self.current) > 2 { self.loaded.removeValue(forKey: k) }
            self.pages[i]?.show(loading: false, image: img, failed: img == nil)
        }
    }

    private func go(_ i: Int) -> Bool {
        guard i >= 0, i < spec.images.count else { return false }
        pager.setContentOffset(CGPoint(x: view.bounds.width * CGFloat(i), y: 0), animated: true)
        return true
    }

    func scrollViewDidScroll(_ s: UIScrollView) {
        guard s === pager, view.bounds.width > 0 else { return }
        let i = min(max(Int((s.contentOffset.x / view.bounds.width).rounded()), 0), spec.images.count - 1)
        guard i != current else { return }
        pages[current]?.setZoomScale(1, animated: false)
        current = i
        pager.isScrollEnabled = (pages[i]?.zoomScale ?? 1) <= ViewerRules.zoomed
        updateCounter()
        showPages()
    }

    private func updateCounter() {
        counter.text = "\(current + 1) / \(spec.images.count)"
        counter.accessibilityLabel = ViewerRules.label(spec.photo, current, spec.images.count)
    }

    // MARK: Gestures

    @objc private func doubleTapped(_ g: UITapGestureRecognizer) {
        guard let p = pages[current] else { return }
        p.doubleTap(at: g.location(in: p))
    }

    /// Up or down closes, only when the picture isn't zoomed.
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard let pan = g as? UIPanGestureRecognizer, let p = pages[current] else { return false }
        let v = pan.velocity(in: view)
        return p.zoomScale <= ViewerRules.zoomed && abs(v.y) > abs(v.x) && !closing
    }

    /// Alongside the pager's and the page's own pans: this one only starts for a mostly vertical drag (above).
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    @objc private func panned(_ g: UIPanGestureRecognizer) {
        guard let p = pages[current] else { return }
        let h = view.bounds.height
        switch g.state {
        case .changed:
            drag = g.translation(in: view).y
            p.transform = CGAffineTransform(translationX: 0, y: drag)
            view.backgroundColor = spec.background.withAlphaComponent(ViewerRules.backgroundAlpha(drag, h) * spec.background.cgColor.alpha)
            bar.alpha = ViewerRules.backgroundAlpha(drag, h)
        case .ended, .cancelled:
            let speed = g.velocity(in: view).y
            if g.state == .ended && ViewerRules.closes(drag, speed, h) {
                UIView.animate(withDuration: 0.2, animations: {
                    p.transform = CGAffineTransform(translationX: 0, y: self.drag > 0 ? h : -h)
                    self.view.backgroundColor = self.spec.background.withAlphaComponent(0)
                }, completion: { _ in self.closeByUser() })
            } else {
                UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
                    p.transform = .identity
                    self.view.backgroundColor = self.spec.background
                    self.bar.alpha = 1
                }
            }
            drag = 0
        default: break
        }
    }

    /// The close button or a swipe: answers the picture on screen.
    private func closeByUser() {
        guard !closing else { return }
        closing = true
        if let key = spec.heldKey { ViewerHeld.release(key) }
        scope.finish(["index": current])
    }
}
