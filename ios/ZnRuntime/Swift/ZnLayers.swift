// startApp's app layers on iOS (host API 9, NAV LAYER), as android/runtime's ZnNavHost.kt TopLayerAndScreens and
// OverlayLayer. The window's root is ZnRootController: the back stack (ZnNavController) with the two layers.
// - `top`: above every screen. Its content takes its own height c; while c > 0 the layer is the status bar area
//   (filled with the layer root's background) plus the content, and the screens move down by c. They keep their own
//   status bar padding (now under the layer: extra safe area makes up for the part UIKit no longer sees), so the
//   layer covers nothing and no screen's insets change. The height animates (open 200 ms, close 250 ms, as RN's
//   offline strip) and clips the content. While it shows, the status bar's icons follow the layer's background.
// - `overlay`: over the whole window, under toasts and alerts. Where it draws nothing tappable, touches go through to
//   the screens. A <Sheet> in it presents as usual.
import SwiftUI
import UIKit

@MainActor
final class ZnRootController: UIViewController {
    let app: ZnApp
    let nav: ZnNavController
    private let top: UIHostingController<ZnTopLayerView>
    private let overlay: UIHostingController<ZnOverlayLayerView>
    private let overlayBox = ZnPassThroughView()
    /// The top layer's content height, and its height now (status bar area included; animated).
    private var content: CGFloat = 0
    private var height: CGFloat = 0
    private var lightIcons = false

    init(app: ZnApp) {
        self.app = app
        nav = ZnNavController(app: app)
        top = UIHostingController(rootView: ZnTopLayerView(app: app, onHeight: { _ in }))
        overlay = UIHostingController(rootView: ZnOverlayLayerView(app: app))
        super.init(nibName: nil, bundle: nil)
        top.rootView = ZnTopLayerView(app: app, onHeight: { [weak self] h in self?.contentChanged(h) })
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        addChild(nav)
        view.addSubview(nav.view)
        nav.didMove(toParent: self)

        // Its own top padding (the status bar), so its safe area never depends on its changing frame.
        top.safeAreaRegions = []
        top.view.backgroundColor = .clear
        top.view.clipsToBounds = true
        addChild(top)
        view.addSubview(top.view)
        top.didMove(toParent: self)

        overlay.view.backgroundColor = .clear
        overlay.safeAreaRegions = []
        addChild(overlay)
        overlayBox.hosting = overlay.view
        overlayBox.addSubview(overlay.view)
        view.addSubview(overlayBox)
        overlay.didMove(toParent: self)
    }

    /// The window's safe area (this view always fills the window), for JS's insets().
    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        let i = view.safeAreaInsets
        let ltr = view.effectiveUserInterfaceLayoutDirection == .leftToRight
        app.reportInsets(top: i.top, bottom: i.bottom, start: ltr ? i.left : i.right, end: ltr ? i.right : i.left)
    }

    override var childForStatusBarStyle: UIViewController? { height > 0 ? nil : nav }
    override var preferredStatusBarStyle: UIStatusBarStyle { lightIcons ? .lightContent : .darkContent }

    private var inset: CGFloat { view.window?.safeAreaInsets.top ?? view.safeAreaInsets.top }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        place()
    }

    private func place() {
        let b = view.bounds
        let down = max(height - inset, 0)
        nav.additionalSafeAreaInsets.top = min(down, inset)
        nav.view.frame = CGRect(x: 0, y: down, width: b.width, height: b.height - down)
        top.view.frame = CGRect(x: 0, y: 0, width: b.width, height: height)
        if top.rootView.statusBar != inset { top.rootView.statusBar = inset }
        overlayBox.frame = b
        overlay.view.frame = overlayBox.bounds
    }

    private func contentChanged(_ c: CGFloat) {
        guard abs(c - content) > 0.5 else { return }
        content = c
        let target = c > 0 ? c + inset : 0
        print("zn t=\(ZnDebug.ms()) layers: top \(c > 0 ? "opens to \(Int(c)) pt" : "closes")")
        lightIcons = app.topLayerIsDark
        UIView.animate(withDuration: target > height ? 0.2 : 0.25, delay: 0, options: [.curveEaseInOut]) {
            self.height = target
            self.place()
            self.view.layoutIfNeeded()
            self.setNeedsStatusBarAppearanceUpdate()
        }
    }
}

/// Lets touches through where the overlay has nothing to tap (SwiftUI answers a hit on empty space with its own view).
final class ZnPassThroughView: UIView {
    weak var hosting: UIView?
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let v = super.hitTest(point, with: event)
        return v === self || v === hosting ? nil : v
    }
}

/// The `top` layer: the status bar area plus the layer's content (its own height), in its root's background.
struct ZnTopLayerView: View {
    let app: ZnApp
    var onHeight: (CGFloat) -> Void
    var statusBar: CGFloat = 0

    var body: some View {
        if let ctx = app.ctx, let id = app.layers[ZnApp.layerTop], let root = app.store.find(id) {
            VStack(spacing: 0) {
                Color.clear.frame(height: statusBar)
                ZnScreenView(ctx: ctx, root: root)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight($0) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(app.layerBackground(root).ignoresSafeArea())
        } else {
            Color.clear.onAppear { onHeight(0) }
        }
    }
}

/// The `overlay` layer, over the whole window.
struct ZnOverlayLayerView: View {
    let app: ZnApp

    var body: some View {
        if let ctx = app.ctx, let id = app.layers[ZnApp.layerOverlay], let root = app.store.find(id) {
            ZnScreenView(ctx: ctx, root: root)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }
}

extension ZnApp {
    static let layerTop = "top", layerOverlay = "overlay"

    /// A layer root's background: its root node's (slot or template), else clear.
    func layerBackground(_ root: ZnInstance) -> Color {
        guard let node = ctx?.templates[safe: root.templateId]?.nodes.first else { return .clear }
        return (node.backgroundSlot >= 0 ? znColor(root.slot(node.backgroundSlot).value) : node.background) ?? .clear
    }

    /// The top layer's background is dark: light status bar icons over it (Android: its luminance).
    var topLayerIsDark: Bool {
        guard let id = layers[Self.layerTop], let root = store.find(id) else { return false }
        var r: CGFloat = 1, g: CGFloat = 1, b: CGFloat = 1, a: CGFloat = 1
        UIColor(layerBackground(root)).getRed(&r, green: &g, blue: &b, alpha: &a)
        return a > 0.5 && (0.2126 * r + 0.7152 * g + 0.0722 * b) < 0.5
    }
}
