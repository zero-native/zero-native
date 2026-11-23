// `imageviewer.page` (module version 3, as android/.../ViewerPage.kt): one picture of the TSX viewer
// (src/ImageViewerScreen.tsx). JS owns the gestures (useZoom) and passes its values; this view loads the picture (web
// with headers, asset, zn://file, file:// inside the app, `data:` held natively), draws it fitted and moved by those
// values each frame (a layer transform, no SwiftUI body), and adds a sharp part of the original on top once the zoom
// rests, as Android does.
//
// Props: `uri`, `held` (ViewerHeld key) and `i` (its index there), `scale`, `x`, `y` (motion values: x / y in points),
// `errorText`, `retryLabel`. Events: `loaded` {width, height} (the fitted copy's pixels: the picture's shape, for
// useZoom's aspect), `error`.
//
// iOS differences:
// - The fitted copy is decoded at the size on screen by ImageIO (Coil on Android); recent ones are kept in a small
//   memory cache (48 MB), so paging back doesn't decode again. A web picture's bytes stay with the page for its sharp
//   parts (Android reads Coil's disk cache).
// - The sharp part is cut from a lazily decoded image (ViewerSource.swift), which reads only the rows or tiles it needs;
//   Android uses BitmapRegionDecoder. Mirror images get none, as on Android.
// - Short of memory (a memory warning), the pages drop their sharp parts and the cache empties (ViewerMemory on Android).
import UIKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif

/// The fitted copies of pictures seen lately, with their bytes, by picture and size.
private enum ViewerPageCache {
    final class Entry {
        let base: CGImage
        let source: ViewerSource
        init(_ base: CGImage, _ source: ViewerSource) { self.base = base; self.source = source }
    }

    static let shared: NSCache<NSString, Entry> = {
        let c = NSCache<NSString, Entry>()
        c.totalCostLimit = 48 << 20
        return c
    }()

    static func put(_ key: String, _ e: Entry) {
        // A mapped file costs no memory of its own; downloaded and held bytes do.
        shared.setObject(e, forKey: key as NSString, cost: e.base.bytesPerRow * e.base.height + e.source.bytes)
    }
}

/// The sharp parts are cut one at a time, off the main thread.
private let viewerSharpQueue = DispatchQueue(label: "zn.image-viewer.sharp", qos: .userInitiated)

final class ViewerPage: UIView {
    private let scope: ZnViewScope
    private let imageView = UIImageView()
    /// The sharp part, not moved by the zoom: it is placed where the part of the picture is on screen for its camera.
    private let sharpView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let errorView = ViewerErrorView()

    /// What the props name: the picture shown.
    private var image = ViewerSpec.Image(uri: "", alt: nil, held: nil)
    private var key = ""
    private var heldKey: String?
    /// Counts loads: an answer for a picture the page no longer shows is dropped.
    private var loads = 0
    private var started = false
    private var failed = false
    private var source: ViewerSource?
    private var base: CGImage?

    private var zoomScale: Float?
    private var zoomX: Float?
    private var zoomY: Float?
    /// The camera the sharp part was cut for.
    private var sharpCamera: ViewerCamera?
    private var sharpWait: DispatchWorkItem?
    private var cuts = 0
    private var memoryWatch: NSObjectProtocol?
    private var laidOut: CGSize = .zero

    init(_ scope: ZnViewScope) {
        self.scope = scope
        super.init(frame: .zero)
        clipsToBounds = true
        // The page is drawn as one picture: the TSX Column around it carries the label and the image role.
        isAccessibilityElement = false
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = false
        addSubview(imageView)
        sharpView.contentMode = .scaleToFill
        sharpView.isHidden = true
        sharpView.isAccessibilityElement = false
        addSubview(sharpView)
        spinner.color = .white
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        errorView.isHidden = true
        errorView.onRetry = { [weak self] in self?.retry() }
        addSubview(errorView)

        read(scope.props)
        scope.onProps = { [weak self] p in self?.read(p) }
        // useZoom's values: each moves the picture in the frame it changes.
        scope.onMotion("scale") { [weak self] v in self?.zoomScale = v; self?.moved() }
        scope.onMotion("x") { [weak self] v in self?.zoomX = v; self?.moved() }
        scope.onMotion("y") { [weak self] v in self?.zoomY = v; self?.moved() }
        memoryWatch = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil,
                                                             queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                ViewerPageCache.shared.removeAllObjects()
                self?.dropSharp()
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        if let memoryWatch { NotificationCenter.default.removeObserver(memoryWatch) }
    }

    // MARK: Props

    private func read(_ p: [String: Any]) {
        let uri = p["uri"] as? String ?? ""
        let held = (p["held"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let i = (p["i"] as? NSNumber)?.intValue ?? 0
        errorView.set(text: text(p["errorText"]) ?? "Couldn't load this photo", retry: text(p["retryLabel"]) ?? "Try again")
        let k = "\(i)|\(held ?? "")|\(uri)"
        guard k != key else { return }
        key = k
        heldKey = held
        image = ViewerSpec.Image(uri: uri, alt: nil, held: ViewerHeld.get(held, i))
        started = false
        source = nil
        base = nil
        imageView.image = nil
        dropSharp()
        setNeedsLayout()
    }

    private func text(_ v: Any?) -> String? { (v as? String).flatMap { $0.isEmpty ? nil : $0 } }

    // MARK: Loading

    override func layoutSubviews() {
        super.layoutSubviews()
        // Not through frame: the image view carries the zoom's transform.
        imageView.bounds = CGRect(origin: .zero, size: bounds.size)
        imageView.center = CGPoint(x: bounds.midX, y: bounds.midY)
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        let w = max(0, min(bounds.width - 48, 320))
        let h = errorView.systemLayoutSizeFitting(CGSize(width: w, height: 0)).height
        errorView.frame = CGRect(x: bounds.midX - w / 2, y: bounds.midY - h / 2, width: w, height: h)
        // Loaded at the first size on screen (Android: Coil's size from the first draw).
        if !started && bounds.width > 0 && bounds.height > 0 { load() }
        if bounds.size != laidOut {
            // A new size (a turn, split view): a sharp part's place is stale.
            if laidOut != .zero { dropSharp(); scheduleSharp() }
            laidOut = bounds.size
        }
    }

    private func screenScale() -> CGFloat { window?.screen.scale ?? traitCollection.displayScale }

    private func load() {
        started = true
        failed = false
        loads += 1
        let mine = loads
        let px = ViewerDims(w: bounds.width * max(1, screenScale()), h: bounds.height * max(1, screenScale()))
        let cacheKey = "\(key)|\(Int(px.w))x\(Int(px.h))"
        if let hit = ViewerPageCache.shared.object(forKey: cacheKey as NSString) {
            return show(hit.base, hit.source)
        }
        errorView.isHidden = true
        // No link yet: the screen can be drawn before JS gives the props. Nothing to load, nothing failed.
        guard !image.uri.isEmpty else { return spinner.stopAnimating() }
        spinner.startAnimating()
        ViewerLoader.fetch(image, base: ZnApp.shared.bundleURL) { [weak self] data in
            // Background queue: read the header, then decode only the fitted copy, at the size on screen.
            let source = data.flatMap { ViewerSource(data: $0) }
            let base = source.flatMap { s -> CGImage? in
                let f = ViewerRules.fitted(s.upright, px)
                return s.fitted(maxPixels: max(f.w, f.h).rounded(.up))
            }
            DispatchQueue.main.async {
                guard let self, self.loads == mine else { return }
                guard let source, let base else { return self.fail(mine) }
                ViewerPageCache.put(cacheKey, .init(base, source))
                self.show(base, source)
            }
        }
    }

    private func show(_ base: CGImage, _ source: ViewerSource) {
        self.base = base
        self.source = source
        spinner.stopAnimating()
        errorView.isHidden = true
        imageView.image = UIImage(cgImage: base)
        scope.emit("loaded", ["width": base.width, "height": base.height])
        scheduleSharp()
    }

    private func fail(_ load: Int) {
        guard load == loads else { return }
        failed = true
        spinner.stopAnimating()
        errorView.isHidden = false
        print("zn image-viewer: failed \(image.uri.hasPrefix("data:") || image.uri == ViewerRules.heldData ? "data: picture" : String(image.uri.prefix(80)))")
        scope.emit("error")
    }

    private func retry() {
        guard failed else { return }
        started = false
        setNeedsLayout()
        layoutIfNeeded()
    }

    // MARK: The zoom

    private func camera() -> ViewerCamera {
        ViewerRules.camera(scale: zoomScale, x: zoomX, y: zoomY, pixels: max(1, screenScale()))
    }

    /// A motion value changed: move the picture (same frame), hide a sharp part cut for another camera, and wait for the
    /// zoom to rest before cutting a new one.
    private func moved() {
        let z = CGFloat(zoomScale.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 1)
        let x = CGFloat(zoomX.flatMap { $0.isFinite ? $0 : nil } ?? 0), y = CGFloat(zoomY.flatMap { $0.isFinite ? $0 : nil } ?? 0)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // About the view's middle, as Android's graphicsLayer: scale, then move.
        imageView.transform = CGAffineTransform(translationX: x, y: y).scaledBy(x: z, y: z)
        sharpView.isHidden = sharpView.image == nil || sharpCamera != camera()
        CATransaction.commit()
        scheduleSharp()
    }

    /// The sharp part for the zoom on screen, made once the zoom has rested and only while the fitted copy is stretched.
    private func scheduleSharp() {
        sharpWait?.cancel()
        guard let base, let source, window != nil, bounds.width > 0 else { return }
        let c = camera()
        let k = max(1, screenScale())
        let screen = ViewerDims(w: bounds.width * k, h: bounds.height * k)
        let fitted = ViewerRules.fitted(ViewerDims(w: CGFloat(base.width), h: CGFloat(base.height)), screen)
        guard ViewerRules.needsSharp(c, fitted, CGFloat(base.width), source.upright.w) else { return dropSharp() }
        if sharpCamera == c, sharpView.image != nil { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.cuts += 1
            let mine = self.cuts
            guard let area = ViewerRules.visibleArea(c, fitted, screen, source.upright).map(ViewerRules.snapped) else { return }
            viewerSharpQueue.async {
                let part = source.decode(area, maxPixels: ViewerRules.areaScreens * screen.w * screen.h)
                DispatchQueue.main.async { [weak self] in
                    guard let self, let part, mine == self.cuts, self.source === source, self.camera() == c else { return }
                    let r = area.screen
                    self.sharpView.image = UIImage(cgImage: part)
                    self.sharpView.frame = CGRect(x: r.left / k, y: r.top / k, width: r.width / k, height: r.height / k)
                    self.sharpCamera = c
                    self.sharpView.isHidden = false
                    #if DEBUG
                    print("zn image-viewer: sharp part \(part.width)x\(part.height) of \(Int(area.source.width))x\(Int(area.source.height)) at zoom \(c.z)")
                    #endif
                }
            }
        }
        sharpWait = work
        DispatchQueue.main.asyncAfter(deadline: .now() + ViewerRules.settle, execute: work)
    }

    private func dropSharp() {
        sharpWait?.cancel()
        cuts += 1
        sharpView.image = nil
        sharpView.isHidden = true
        sharpCamera = nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Off screen (paged far away, the screen closed): the sharp part goes; it comes back when the page shows again.
        if window == nil { dropSharp() } else { scheduleSharp() }
    }
}

/// A picture that didn't load: a picture sign, the words and a retry button, white on the dark backdrop (Android's
/// LoadError). Shared by the page and the native screen.
final class ViewerErrorView: UIStackView {
    private let label = UILabel()
    private let button = UIButton(type: .system)
    var onRetry: (() -> Void)?

    init() {
        super.init(frame: .zero)
        label.textColor = .white
        label.numberOfLines = 0
        label.textAlignment = .center
        button.addAction(UIAction { [weak self] _ in self?.onRetry?() }, for: .primaryActionTriggered)
        button.setTitleColor(.white, for: .normal)
        button.layer.borderColor = UIColor.white.withAlphaComponent(0.6).cgColor
        button.layer.borderWidth = 1
        button.layer.cornerRadius = 18
        button.contentEdgeInsets = UIEdgeInsets(top: 8, left: 18, bottom: 8, right: 18)
        axis = .vertical
        alignment = .center
        spacing = 16
        // A picture sign over the words, as Android's broken-picture drawing.
        let sign = UIImageView(image: UIImage(systemName: "photo", withConfiguration: UIImage.SymbolConfiguration(pointSize: 40, weight: .light)))
        sign.tintColor = UIColor.white.withAlphaComponent(0.7)
        sign.isAccessibilityElement = false
        addArrangedSubview(sign)
        addArrangedSubview(label)
        addArrangedSubview(button)
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError() }

    func set(text: String, retry: String) {
        if label.text != text { label.text = text }
        if button.title(for: .normal) != retry { button.setTitle(retry, for: .normal) }
    }
}
