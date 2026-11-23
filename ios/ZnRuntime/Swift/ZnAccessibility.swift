// Accessibility on iOS (registry 15), as android/runtime's ZnTemplate.kt accessibilitySemantics and ZnPress.kt: what
// VoiceOver reads (accessibilityLabel, also from a slot; accessibilityHint; accessibilityRole; accessibilityHidden),
// and RN testID as the accessibilityIdentifier UI tests find (Android: testTag as the resource id).
//
// - A Pressable is one element (Compose's mergeDescendants): its texts read together, or its label. A button unless its
//   role says otherwise ("none": no role, the action stays). VoiceOver's double tap sends onPress (no onPressIn / Out,
//   as Android); a "Long press" action sends onLongPress while JS has a handler. A disabled one reads "dimmed" and does
//   nothing.
// - A Pressable with a Switch, a TextField or another button inside (ZnTemplate's hasInteractiveDescendant): those
//   stay their own elements, as Android's merge boundaries, and the Pressable is still one element of its own, read
//   first: its label, else its plain texts (the ones Compose merges: no label, no tap of their own), with its action.
//   Those texts are then not read again on their own (znA11yMerged). A labelled box with a control inside is the same.
// - Other nodes (ZnA11y, over the paint in ZnNodeView.styled, so the element is the box inside the margin): hidden
//   hides the whole subtree; a label makes the node one element read as that label; a role alone adds its trait but
//   keeps the children separate (Android merges only with a label). An Image, Svg or Canvas with a label reads as an
//   image (Android's Role.Image); a labelled Icon or Shimmer is read by its label. Without a label every picture is
//   decorative and skipped, as on Android, also with a testID (so a UI test can't find an unlabelled picture).
// - A label from a slot that holds no string now reads as if none was written, as Android's: the element's own texts,
//   and a picture is decorative again.
// - Switch, Checkbox, TextField, OtpInput and NativeView apply label, hint and testID on their own element; ZnA11y
//   only hides them.
// - testID: on the element when the node is one; on a plain container, the container becomes one that holds its
//   children (so the identifier isn't copied onto each child).
// Every branch here depends only on the template (never on a slot), so a label or long press that changes at runtime
// never rebuilds what is inside.
//
// iOS differences: a hint is read after the element on every node (Android reads a Pressable's hint as its "double tap
// to ..." label and has none elsewhere); roles "link" and "text" read as a link and as text, on a Pressable and on a
// tappable Text, and "none" takes the button off a tappable Text (Android: a button in each case).
import SwiftUI
import UIKit

extension ZnNodeSpec {
    /// The label now: the slot's text when the label comes from one (read here, so a change redraws the reader), else
    /// the written one. Nil for a slot that holds no string, as Android's `as? String`.
    @MainActor func accessibilityLabelNow(_ inst: ZnInstance) -> String? {
        accessibilityLabelSlot >= 0 ? inst.slot(accessibilityLabelSlot).value.string : accessibilityLabel
    }

    /// A label is written or comes from a slot (known from the template).
    var hasAccessibilityLabel: Bool { accessibilityLabel != nil || accessibilityLabelSlot >= 0 }

    /// Draws a picture: read by its label with one, skipped without one.
    var isImageLike: Bool {
        typealias C = Registry.Component
        return type == C.image || type == C.svg || type == C.icon || type == C.shimmer || type == C.canvas
    }

    /// A labelled one reads as an image (Android's imageRole: Image, Svg and Canvas, not Icon or Shimmer).
    var isImageRole: Bool {
        typealias C = Registry.Component
        return type == C.image || type == C.svg || type == C.canvas
    }

    /// ZnA11y has work to do: an accessibility prop, a testID, or a picture.
    var needsA11y: Bool { hasA11y || testID != nil || type == Registry.Component.canvas }

    /// Its own element under a Pressable, never merged into the Pressable's text (Android's merge boundaries).
    var isA11yBoundary: Bool {
        typealias C = Registry.Component
        switch type {
        case C.pressable, C.switch, C.checkbox, C.textField, C.otpInput, C.nativeView: return true
        case C.text: return onPress != 0 || onLongPress != 0 || onSpanPress != 0
        default: return false
        }
    }

    /// A Text a Pressable reads as part of itself (no label, no tap of its own).
    var isMergedText: Bool { type == Registry.Component.text && !hasAccessibilityLabel && !isA11yBoundary }
}

/// What a Text reads now: its text (or slot, or motion value) with its textTransform, spans joined.
@MainActor func znTextNow(_ s: ZnNodeSpec, _ inst: ZnInstance) -> String {
    let raw = s.textSlot >= 0 ? znTextShown(inst.slot(s.textSlot).value) : (s.text ?? "")
    return s.textTransform > 0 ? znTransformText(raw, s.textTransform) : raw
}

/// The texts under [node] a Pressable or a labelled box reads as its own (Compose's merged descendants), in order and
/// joined as VoiceOver joins a combined element's: each unlabelled, untappable Text, not inside a control, another
/// Pressable, a labelled node, a hidden one or one with display none. Mounted children (anchors) count too.
@MainActor func znMergedText(_ ctx: ZnContext, _ inst: ZnInstance, _ node: Int) -> String {
    guard let t = ctx.templates[safe: inst.templateId] else { return "" }
    var parts: [String] = []
    func walk(_ t: ZnTemplate, _ inst: ZnInstance, _ children: [Int]) {
        for r in znChildRefs(ctx, t, inst, children) {
            let c = r.t.nodes[r.node]
            if c.accessibilityHidden || c.isA11yBoundary || c.hasAccessibilityLabel || c.displayNoneNow(r.inst) { continue }
            if c.type == Registry.Component.text {
                let text = znTextNow(c, r.inst).replacingOccurrences(of: "\u{1F}", with: "")
                if !text.isEmpty { parts.append(text) }
            } else {
                walk(r.t, r.inst, c.children)
            }
        }
    }
    walk(t, inst, t.nodes[node].children)
    return parts.joined(separator: ", ")
}

/// VoiceOver traits for accessibilityRole (-1: not written). "none" and not written add nothing.
func znRoleTraits(_ role: Int) -> AccessibilityTraits {
    typealias R = Registry.AccessibilityRole
    switch role {
    case R.button: return .isButton
    case R.header: return .isHeader
    case R.image: return .isImage
    case R.link: return .isLink
    case R.text: return .isStaticText
    case R.switch, R.checkbox: return .isToggle
    default: return []
    }
}

private struct ZnA11yMergedKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// Inside a Pressable (or labelled box) that keeps a control inside and reads its plain texts itself: those texts
    /// (isMergedText) are hidden, so VoiceOver doesn't read them twice. Off again inside a nested Pressable or
    /// labelled node, which reads its own.
    var znA11yMerged: Bool {
        get { self[ZnA11yMergedKey.self] }
        set { self[ZnA11yMergedKey.self] = newValue }
    }
}

/// [f] on the view only when [on], which must come from the template, so the branch never changes for a node.
private extension View {
    @ViewBuilder func znWhen<T: View>(_ on: Bool, _ f: (Self) -> T) -> some View {
        if on { f(self) } else { self }
    }

    /// The label [now] (written or from a slot). Nil now (the slot holds no string): the element reads as if no label
    /// were written, as Android: iOS 18 turns the label off; iOS 17, which can't, reads [fallback] (what it would read).
    @ViewBuilder func znLabel(_ now: String?, fallback: () -> String) -> some View {
        if #available(iOS 18, *) {
            self.accessibilityLabel(Text(now ?? ""), isEnabled: now != nil)
        } else {
            self.accessibilityLabel(now ?? fallback())
        }
    }
}

// MARK: - Pressable

/// A Pressable's element (ZnPress.kt semantics), applied over its touch view.
struct ZnPressA11y: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let disabled: Bool

    func body(content: Content) -> some View {
        #if DEBUG
        let _ = ZnA11yDebug.startOnce()
        #endif
        let (ctx, s, inst, disabled) = (ctx, s, inst, disabled)
        // Its children's own state (a TextField, a Switch inside) stays usable, as on Android: only the element
        // reads dimmed. Its plain texts are hidden when the element reads them itself (a control inside), else they
        // are combined (a nested Pressable's are its own again).
        let inner = content.environment(\.isEnabled, true).environment(\.znA11yMerged, s.hasInteractiveDescendant)
        if s.hasInteractiveDescendant {
            // The controls stay their own elements; the Pressable's own is a box behind them, read first.
            inner
                .background {
                    Color.clear
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(s.accessibilityLabelNow(inst) ?? znMergedText(ctx, inst, s.index))
                        .modifier(ZnPressActions(ctx: ctx, s: s, inst: inst, disabled: disabled))
                        .accessibilitySortPriority(1)
                }
                .accessibilityElement(children: .contain)
                .znWhen(s.accessibilityHidden) { $0.accessibilityHidden(true) }
                .environment(\.isEnabled, !disabled)
        } else {
            inner
                .accessibilityElement(children: .combine)
                .znWhen(s.hasAccessibilityLabel) {
                    $0.znLabel(s.accessibilityLabelNow(inst)) { znMergedText(ctx, inst, s.index) }
                }
                .modifier(ZnPressActions(ctx: ctx, s: s, inst: inst, disabled: disabled))
                .znWhen(s.accessibilityHidden) { $0.accessibilityHidden(true) }
                // VoiceOver reads a disabled element as "dimmed".
                .environment(\.isEnabled, !disabled)
        }
    }
}

/// A Pressable element's hint, role, actions and testID.
private struct ZnPressActions: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let disabled: Bool
    @Environment(\.znReorderRow) private var reorderRow

    func body(content: Content) -> some View {
        let role = s.accessibilityRole
        // Not written: a button, as Android's Role.Button default.
        let traits: AccessibilityTraits = role < 0 ? .isButton : znRoleTraits(role)
        // Not in a row of a reorderable List (decision 7: the long press picks the row up there).
        let longPressOn = !reorderRow && s.onLongPress != 0 && (s.hasLongPressSlot < 0 || inst.slot(s.hasLongPressSlot).value != .bool(false))
        let (ctx, s, inst, disabled) = (ctx, s, inst, disabled)
        content
            .znWhen(s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
            .accessibilityAction {
                if !disabled && s.onPress != 0 { ctx.send(inst.id, s.onPress, .none) }
            }
            // SwiftUI makes an element with an action a button, and one of texts static text: another role ("none",
            // "text", "link", ...) takes both off, then adds its own.
            .znWhen(role >= 0 && role != Registry.AccessibilityRole.button) { $0.accessibilityRemoveTraits([.isButton, .isStaticText]) }
            .accessibilityAddTraits(traits)
            .accessibilityActions {
                // Only while JS has a handler (the hasLongPress slot), as Android's onLongClick.
                if longPressOn {
                    Button("Long press") { if !disabled { ctx.send(inst.id, s.onLongPress, .none) } }
                }
            }
            .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
    }
}

// MARK: - Other nodes

/// Accessibility of a node that isn't a Pressable (ZnTemplate.kt accessibilitySemantics). Applied after the paint in
/// ZnNodeView.styled; nodes without accessibility props pass straight through.
struct ZnA11y: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if !s.needsA11y || s.isPressable {
            content  // the usual case (a Pressable has ZnPressA11y)
        } else {
            content.modifier(ZnNodeA11y(s: s, inst: inst))
        }
    }
}

private struct ZnNodeA11y: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    private enum Kind { case own, picture, text, container }

    private var kind: Kind {
        typealias C = Registry.Component
        switch s.type {
        case C.textField, C.otpInput, C.switch, C.checkbox, C.nativeView: return .own
        case C.text: return .text
        default: return s.isImageLike ? .picture : .container
        }
    }

    func body(content: Content) -> some View {
        let (s, inst) = (s, inst)
        let role = s.accessibilityRole
        let roleTraits = znRoleTraits(role)
        // "none" is no role, as Android's (no semantics without a label).
        let hasRole = role >= 0 && role != Registry.AccessibilityRole.none
        switch kind {
        case .own:
            // Label, hint and testID are on their own element (ZnControls, ZnTextField, ZnOtpInput, ZnPlugins).
            content.znWhen(s.accessibilityHidden) { $0.accessibilityHidden(true) }
        case .picture:
            if s.accessibilityHidden || (!s.hasAccessibilityLabel && !hasRole) {
                content.accessibilityHidden(true)  // decorative, as Android (no content description)
            } else {
                let now = s.accessibilityLabelNow(inst)
                content
                    .accessibilityElement(children: .ignore)
                    .znWhen(s.hasAccessibilityLabel) { $0.accessibilityLabel(now ?? "") }
                    .znWhen(s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
                    .accessibilityAddTraits(role < 0 ? (s.isImageRole ? .isImage : []) : roleTraits)
                    .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
                    // A label from a slot that holds no string now: decorative again.
                    .accessibilityHidden(!hasRole && now == nil)
            }
        case .text:
            if s.accessibilityHidden {
                content.accessibilityHidden(true)
            } else {
                content
                    .znWhen(s.hasAccessibilityLabel) {
                        $0.znLabel(s.accessibilityLabelNow(inst)) { znTextNow(s, inst).replacingOccurrences(of: "\u{1F}", with: "") }
                    }
                    .znWhen(s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
                    .accessibilityAddTraits(roleTraits)
                    .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
            }
        case .container:
            if s.accessibilityHidden {
                content.accessibilityHidden(true)  // the whole subtree, as Android's hideFromAccessibility
            } else if s.hasAccessibilityLabel {
                // One element read as its label (Android: mergeDescendants with the label). A label from a slot that
                // holds no string now: the children read on their own, as Android's (no merge without a label).
                let now = s.accessibilityLabelNow(inst)
                if s.hasInteractiveDescendant {
                    // With a control inside: the controls stay their own elements, the box's own is behind them.
                    content
                        .environment(\.znA11yMerged, now != nil)
                        .background {
                            Color.clear
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(now ?? "")
                                .znWhen(s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
                                .accessibilityAddTraits(roleTraits)
                                .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
                                .accessibilitySortPriority(1)
                                .accessibilityHidden(now == nil)
                        }
                        .accessibilityElement(children: .contain)
                } else {
                    content
                        .environment(\.znA11yMerged, false)
                        .accessibilityElement(children: now != nil ? .combine : .contain)
                        .accessibilityLabel(now ?? "")
                        .znWhen(s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
                        .accessibilityAddTraits(roleTraits)
                        .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
                }
            } else {
                // A role alone (header, ...): its trait, the children stay separate (Android: no merge without a
                // label). A testID alone: a container that holds the children.
                content
                    .znWhen(hasRole || s.testID != nil) { $0.accessibilityElement(children: .contain) }
                    .accessibilityAddTraits(hasRole ? roleTraits : [])
                    .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
            }
        }
    }
}

extension View {
    /// Label, hint and testID on a SwiftUI control's element (Switch, Checkbox, the SwiftUI TextField), each only when
    /// written. [label]: accessibilityLabelNow, read by the caller's body.
    func znFieldA11y(_ s: ZnNodeSpec, label: String?) -> some View {
        self.znWhen(s.hasAccessibilityLabel) { $0.accessibilityLabel(label ?? "") }
            .znWhen(s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
            .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
    }
}

// MARK: - UIKit views (TextField, OtpInput, NativeView)

/// Label, hint, testID and hidden on a UIKit view of a node, each only when written (the view's own stay otherwise:
/// a field's placeholder is its label). [label]: accessibilityLabelNow, read by the caller's body.
@MainActor func znApplyA11y(_ v: UIView, _ s: ZnNodeSpec, label: String?) {
    if s.hasAccessibilityLabel, v.accessibilityLabel != label { v.accessibilityLabel = label }
    if let hint = s.accessibilityHint, v.accessibilityHint != hint { v.accessibilityHint = hint }
    if let id = s.testID, v.accessibilityIdentifier != id { v.accessibilityIdentifier = id }
    if s.accessibilityHidden { v.accessibilityElementsHidden = true }
}

// MARK: - Gestures

/// VoiceOver for a node's gestures that have an `a11yLabel` (Android: ZnGesture.kt's semantics; VoiceOver users can't
/// drag or pinch), drawn by ZnGestureHub.swift behind the node, inside its layer (so it moves with the node):
/// - a tap gesture: the element is a button, and VoiceOver's double tap sends its onEnd with `accessibility: true`;
/// - useZoom: actions "<label>: zoom in" (at the centre, to the double tap's scale) and "<label>: zoom out" (names from
///   `a11yActions.zoomIn` / `zoomOut`);
/// - each anchor: an action "<label>: <anchor id>" (or `a11yActions[id]`) that settles there and sends onEnd with
///   `{anchor, accessibility: true}`;
/// - iOS only, as a slider: a one-axis pan with two or more anchors is adjustable (swipe up / down goes to the next
///   anchor: along x to the right, along y up), its value the anchor it rests nearest to; one with no anchors and both
///   bounds on its axis moves a tenth of them per swipe, its value a percentage. Each sends onEnd with
///   `accessibility: true`.
/// The element reads the node's label, else the gesture's a11yLabel (the node's texts stay elements of their own: a
/// knob's "›" isn't a name). A node with its own label that ZnA11y makes one element (no control inside) reads that
/// label: this element has none and merges into it with its actions.
struct ZnGestureA11y: View {
    let s: ZnNodeSpec
    let inst: ZnInstance
    /// The node's gestures with an a11yLabel (leaves).
    let leaves: [ZnGesture]

    /// ZnA11y makes the node one element with its own label: this element merges into it.
    static func mergesIntoNode(_ s: ZnNodeSpec) -> Bool { s.hasAccessibilityLabel && !s.hasInteractiveDescendant && !s.isPressable }

    var body: some View {
        let tap = leaves.first { $0.kind == ZnGesture.tap }
        let slider = leaves.first { $0.kind == ZnGesture.pan && $0.axis != ZnGesture.axisXY && ($0.anchors.count >= 2 || Self.range($0) != nil) }
        let label = Self.mergesIntoNode(s) ? nil : s.accessibilityLabelNow(inst) ?? leaves.first?.a11yLabel
        // (SwiftUI lists accessibilityActions last to first: given reversed, VoiceOver offers them in Android's order.)
        let actions = Self.actions(leaves).reversed()
        Color.clear
            .accessibilityElement(children: .ignore)
            .znWhen(label != nil) { $0.accessibilityLabel(label ?? "") }
            .znWhen(tap != nil) { v in
                v.accessibilityAddTraits(.isButton)
                    .accessibilityAction { tap?.send("end", ["cancelled": false, "accessibility": true]) }
            }
            .znWhen(slider != nil) { v in
                v.accessibilityValue(slider.map(Self.value) ?? "")
                    .accessibilityAdjustableAction { d in if let slider { Self.step(slider, up: d == .increment) } }
            }
            .accessibilityActions {
                ForEach(Array(actions), id: \.name) { a in Button(a.name) { a.run() } }
            }
    }

    private struct Action {
        let name: String
        let run: () -> Void
    }

    /// Android's custom actions, in its order: per gesture, zoom in / out, then its anchors.
    private static func actions(_ leaves: [ZnGesture]) -> [Action] {
        var out: [Action] = []
        for leaf in leaves {
            let names = leaf.o["a11yActions"] as? [String: Any]
            func name(_ key: String, _ fallback: String) -> String {
                (names?[key] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "\(leaf.a11yLabel ?? ""): \(fallback)"
            }
            if leaf.kind == ZnGesture.zoom {
                out.append(Action(name: name("zoomIn", "zoom in")) { leaf.zoomInAtCentre() })
                out.append(Action(name: name("zoomOut", "zoom out")) { leaf.zoomAnimate(leaf.zoomMin, 0, 0) })
            }
            for a in leaf.anchors {
                out.append(Action(name: name(a.id, a.id)) { go(leaf, a) })
            }
        }
        // (Two gestures with the same action name: the first one's.)
        var seen = Set<String>()
        return out.filter { seen.insert($0.name).inserted }
    }

    /// Settles [g] on anchor [a], as if released there; onEnd says so.
    private static func go(_ g: ZnGesture, _ a: ZnAnchor) {
        let (ax, ay) = g.anchorPoint(a)
        g.touch?.cancel()
        g.settle(ZnGesture.Target(id: a.id, x: ax, y: ay), 0, 0)
        g.send("end", ["anchor": a.id, "cancelled": false, "accessibility": true])
    }

    /// A one-axis pan's anchors in their order on screen (x: left to right; y: bottom to top), with their points.
    private static func ordered(_ g: ZnGesture) -> [(ZnAnchor, Float)] {
        let onX = g.axis == ZnGesture.axisX
        let points = g.anchors.compactMap { a -> (ZnAnchor, Float)? in
            let p = g.anchorPoint(a)
            return (onX ? p.0 : p.1).map { (a, $0) }
        }
        return points.sorted { onX ? $0.1 < $1.1 : $0.1 > $1.1 }
    }

    private static func nearest(_ g: ZnGesture) -> ZnAnchor? {
        let at = (g.axis == ZnGesture.axisX ? g.x : g.y)?.value ?? 0
        return ordered(g).min { abs($0.1 - at) < abs($1.1 - at) }?.0
    }

    /// A one-axis pan's bounds on its axis (low, high), when it has both and they differ.
    private static func range(_ g: ZnGesture) -> (Float, Float)? {
        let onX = g.axis == ZnGesture.axisX
        guard let lo = g.lo(onX), let hi = g.hi(onX), hi != lo else { return nil }
        return (lo, hi)
    }

    /// What VoiceOver reads as the slider's value: the anchor it rests nearest to, or how far along its bounds.
    private static func value(_ g: ZnGesture) -> String {
        if g.anchors.count >= 2 { return nearest(g)?.id ?? "" }
        guard let (lo, hi) = range(g) else { return "" }
        let at = (g.axis == ZnGesture.axisX ? g.x : g.y)?.value ?? lo
        let p = (at - lo) / (hi - lo)
        return "\(Int(((g.axis == ZnGesture.axisX ? p : 1 - p) * 100).rounded()))%"
    }

    /// VoiceOver's swipe up / down on an adjustable pan: the next anchor that way, or a tenth of its bounds.
    private static func step(_ g: ZnGesture, up: Bool) {
        if g.anchors.count >= 2 {
            let list = ordered(g)
            guard let cur = nearest(g), let i = list.firstIndex(where: { $0.0.id == cur.id }) else { return }
            let j = up ? i + 1 : i - 1
            guard list.indices.contains(j) else { return }
            return go(g, list[j].0)
        }
        let onX = g.axis == ZnGesture.axisX
        guard let (lo, hi) = range(g), let v = onX ? g.x : g.y else { return }
        // Up: to the right along x, up the screen along y.
        let by = (hi - lo) / 10 * (up == onX ? 1 : -1)
        let to = min(max(v.value + by, min(lo, hi)), max(lo, hi))
        // At once (the next swipe steps on from there), as VoiceOver's own sliders.
        g.touch?.cancel()
        g.detach()
        v.interrupt()
        v.value = to
        g.send("end", [onX ? "x" : "y": Double(to), "cancelled": false, "accessibility": true])
    }
}

// MARK: - Debug: the accessibility tree

#if DEBUG
/// ZN_A11Y_DUMP=<seconds> (a Debug build): that long after the first screen, prints what VoiceOver sees (each element's
/// label, value, traits, frame and custom actions), runs ZN_A11Y_DO, then prints it again. ZN_A11Y_DO: steps split by
/// "|": "action:<name>" runs the first custom action whose name contains it, "activate:<label>" VoiceOver's double tap,
/// "inc:<label>" / "dec:<label>" a swipe up / down on an adjustable element. For lab checks without VoiceOver's UI.
@MainActor
enum ZnA11yDebug {
    private static var started = false

    static func startOnce() {
        guard !started else { return }
        started = true
        let env = ProcessInfo.processInfo.environment
        guard let s = env["ZN_A11Y_DUMP"].flatMap(Double.init) else { return }
        // SwiftUI builds its accessibility tree only while an assistive app asks: turn the app's accessibility on, as
        // UI tests do (libAccessibility, a Debug-only check).
        if let lib = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
           let f = dlsym(lib, "_AXSApplicationAccessibilitySetEnabled") {
            unsafeBitCast(f, to: (@convention(c) (Bool) -> Void).self)(true)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + s) {
            dump("before")
            guard let steps = env["ZN_A11Y_DO"], !steps.isEmpty else { return }
            for step in steps.split(separator: "|") { run(String(step)) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { dump("after") }
        }
    }

    private static func elements() -> [NSObject] {
        var out: [NSObject] = []
        func walk(_ o: NSObject, _ depth: Int) {
            guard depth < 80 else { return }
            if let v = o as? UIView, v.isHidden || v.alpha < 0.01 || v.accessibilityElementsHidden { return }
            if o.isAccessibilityElement { out.append(o) }
            if let kids = o.accessibilityElements as? [NSObject], !kids.isEmpty {
                for k in kids { walk(k, depth + 1) }
            } else if let v = o as? UIView, !o.isAccessibilityElement {
                for k in v.subviews { walk(k, depth + 1) }
            }
        }
        for scene in UIApplication.shared.connectedScenes {
            for w in (scene as? UIWindowScene)?.windows ?? [] where !w.isHidden { walk(w, 0) }
        }
        return out
    }

    private static func dump(_ when: String) {
        print("zn a11y \(when):")
        for e in elements() {
            let f = e.accessibilityFrame
            var traits: [String] = []
            let t = e.accessibilityTraits
            if t.contains(.button) { traits.append("button") }
            if t.contains(.adjustable) { traits.append("adjustable") }
            if t.contains(.image) { traits.append("image") }
            if t.contains(.header) { traits.append("header") }
            if t.contains(.staticText) { traits.append("text") }
            let actions = (e.accessibilityCustomActions ?? []).map(\.name)
            print("zn a11y   \"\(e.accessibilityLabel ?? "")\" value \"\(e.accessibilityValue ?? "")\" [\(traits.joined(separator: ","))] at (\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width))x\(Int(f.height)))\(actions.isEmpty ? "" : " actions \(actions)")")
        }
    }

    private static func run(_ step: String) {
        let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return }
        let (kind, what) = (parts[0], parts[1])
        let all = elements()
        switch kind {
        case "action":
            for e in all {
                guard let a = (e.accessibilityCustomActions ?? []).first(where: { $0.name.contains(what) }) else { continue }
                print("zn a11y do: action \"\(a.name)\"")
                if let h = a.actionHandler { _ = h(a) } else if let t = a.target as? NSObject { _ = t.perform(a.selector, with: a) }
                return
            }
        default:
            let adjusts = kind == "inc" || kind == "dec"
            guard let e = all.first(where: { e in
                (e.accessibilityLabel ?? "").contains(what) && (!adjusts || e.accessibilityTraits.contains(.adjustable))
            }) else { break }
            print("zn a11y do: \(kind) \"\(e.accessibilityLabel ?? "")\"")
            switch kind {
            case "activate": _ = e.accessibilityActivate()
            case "inc": e.accessibilityIncrement()
            case "dec": e.accessibilityDecrement()
            default: break
            }
            return
        }
        print("zn a11y do: nothing matches \(step)")
    }
}
#endif
