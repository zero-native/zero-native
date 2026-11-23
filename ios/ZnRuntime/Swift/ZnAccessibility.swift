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
