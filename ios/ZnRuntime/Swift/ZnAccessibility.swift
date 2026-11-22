// Accessibility on iOS (registry 15), as android/runtime's ZnTemplate.kt accessibilitySemantics and ZnPress.kt: what
// VoiceOver reads (accessibilityLabel, also from a slot; accessibilityHint; accessibilityRole; accessibilityHidden),
// and RN testID as the accessibilityIdentifier UI tests find (Android: testTag as the resource id).
//
// - A Pressable is one element (Compose's mergeDescendants): its texts read together, or its label. A button unless its
//   role says otherwise ("none": no role, the action stays). VoiceOver's double tap sends onPress (no onPressIn / Out,
//   as Android); a "Long press" action sends onLongPress while JS has a handler. A disabled one reads "dimmed" and does
//   nothing. With a Switch, a TextField or another button inside, those stay their own elements (ZnTemplate's
//   hasInteractiveDescendant) and the Pressable is their container.
// - Other nodes (ZnA11y, over the paint in ZnNodeView.styled, so the element is the box inside the margin): hidden
//   hides the whole subtree; a label makes the node one element read as that label; a role makes it an element with
//   that trait (header: VoiceOver's headings rotor). An Image, Svg, Icon, Shimmer or Canvas with a label reads as an
//   image; without one it is decorative and skipped, as on Android.
// - Switch, Checkbox, TextField, OtpInput and NativeView apply label, hint and testID on their own element; ZnA11y
//   only hides them.
// - testID: on the element when the node is one; on a plain container, the container becomes one that holds its
//   children (so the identifier isn't copied onto each child).
// Every branch here depends only on the template (never on a slot), so a label or long press that changes at runtime
// never rebuilds what is inside.
//
// iOS differences: a hint is read after the element on every node (Android reads a Pressable's hint as its "double tap
// to ..." label and has none elsewhere); roles "link" and "text" read as a link and as text (Android: a button on a
// Pressable, nothing elsewhere).
import SwiftUI
import UIKit

extension ZnNodeSpec {
    /// The label now: the slot's text when the label comes from one (read here, so a change redraws the reader), else
    /// the written one.
    @MainActor func accessibilityLabelNow(_ inst: ZnInstance) -> String? {
        accessibilityLabelSlot >= 0 ? inst.slot(accessibilityLabelSlot).value.string : accessibilityLabel
    }

    /// A label is written or comes from a slot (known from the template).
    var hasAccessibilityLabel: Bool { accessibilityLabel != nil || accessibilityLabelSlot >= 0 }

    /// Draws a picture: read as an image with a label, skipped without one.
    var isImageLike: Bool {
        typealias C = Registry.Component
        return type == C.image || type == C.svg || type == C.icon || type == C.shimmer || type == C.canvas
    }

    /// ZnA11y has work to do: an accessibility prop, a testID, or a picture.
    var needsA11y: Bool { hasA11y || testID != nil || type == Registry.Component.canvas }
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

/// [f] on the view only when [on], which must come from the template, so the branch never changes for a node.
private extension View {
    @ViewBuilder func znWhen<T: View>(_ on: Bool, _ f: (Self) -> T) -> some View {
        if on { f(self) } else { self }
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
        let role = s.accessibilityRole
        // Not written: a button, as Android's Role.Button default.
        let traits: AccessibilityTraits = role < 0 ? .isButton : znRoleTraits(role)
        let longPressOn = s.onLongPress != 0 && (s.hasLongPressSlot < 0 || inst.slot(s.hasLongPressSlot).value != .bool(false))
        let (ctx, s, inst, disabled) = (ctx, s, inst, disabled)
        content
            // Its children's own state (a TextField, a Switch inside) stays usable, as on Android: only the element
            // reads dimmed.
            .environment(\.isEnabled, true)
            .accessibilityElement(children: s.hasInteractiveDescendant ? .contain : .combine)
            .znWhen(s.hasAccessibilityLabel) { $0.accessibilityLabel(s.accessibilityLabelNow(inst) ?? "") }
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
            .znWhen(s.accessibilityHidden) { $0.accessibilityHidden(true) }
            // VoiceOver reads a disabled element as "dimmed".
            .environment(\.isEnabled, !disabled)
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
        switch kind {
        case .own:
            // Label, hint and testID are on their own element (ZnControls, ZnTextField, ZnOtpInput, ZnPlugins).
            content.znWhen(s.accessibilityHidden) { $0.accessibilityHidden(true) }
        case .picture:
            if s.accessibilityHidden || (!s.hasAccessibilityLabel && s.testID == nil && role < 0) {
                content.accessibilityHidden(true)  // decorative, as Android (no content description)
            } else {
                content
                    .accessibilityElement(children: .ignore)
                    .znWhen(s.hasAccessibilityLabel) { $0.accessibilityLabel(s.accessibilityLabelNow(inst) ?? "") }
                    .znWhen(s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
                    .accessibilityAddTraits(role < 0 ? .isImage : roleTraits)
                    .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
            }
        case .text:
            if s.accessibilityHidden {
                content.accessibilityHidden(true)
            } else {
                content
                    .znWhen(s.hasAccessibilityLabel) { $0.accessibilityLabel(s.accessibilityLabelNow(inst) ?? "") }
                    .znWhen(s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
                    .accessibilityAddTraits(roleTraits)
                    .znWhen(s.testID != nil) { $0.accessibilityIdentifier(s.testID ?? "") }
            }
        case .container:
            if s.accessibilityHidden {
                content.accessibilityHidden(true)  // the whole subtree, as Android's hideFromAccessibility
            } else {
                // A label or a role makes the box one element; with a control inside, a container of elements.
                let element = s.hasAccessibilityLabel || (role >= 0 && role != Registry.AccessibilityRole.none)
                let children: AccessibilityChildBehavior = element && !s.hasInteractiveDescendant ? .combine : .contain
                content
                    .znWhen(element || s.testID != nil) { $0.accessibilityElement(children: children) }
                    .znWhen(s.hasAccessibilityLabel) { $0.accessibilityLabel(s.accessibilityLabelNow(inst) ?? "") }
                    .znWhen(element && s.accessibilityHint != nil) { $0.accessibilityHint(s.accessibilityHint ?? "") }
                    .accessibilityAddTraits(element ? roleTraits : [])
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
