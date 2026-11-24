// Switch, Checkbox, Spinner and Progress on iOS, drawn as android/runtime draws them (ZnSwitch.kt, ZnCheckbox.kt,
// ZnSpinner.kt, ZnProgress.kt), so they look the same on both platforms (not UISwitch: zn components have one look).
// - Switch / Checkbox are controlled: they show `value` and a tap sends onValueChange(!value); JS decides. The change
//   animates in 150 ms (not on first show). Disabled: 0.38 opacity, no taps. A 48 × 48 touch area, as Android's, and
//   a round 20 pt halo while pressed (Android's ripple). Inside a Pressable the control takes its own tap (A53).
//   The 0.38 fades each part on its own (the track shows through the thumb), as Android draws each at 0.38 alpha.
// - Spinner: a 270° arc turning once a second, `size` (24) and `color`.
// - Progress: as wide as its parent, `height` (4) tall; a `value` 0–1 animates in 150 ms; no value: a bar sliding
//   across every 1.2 s.
import SwiftUI

private let znGreen = Color(.sRGB, red: 0x10 / 255, green: 0xB9 / 255, blue: 0x81 / 255)

/// A Switch / Checkbox value: the slot's, else the template's (true, or "true").
@MainActor
private func znToggleValue(_ s: ZnNodeSpec, _ inst: ZnInstance) -> Bool {
    let v = s.valueSlot >= 0 ? inst.slot(s.valueSlot).value : (s.props[Registry.Prop.value] ?? .null)
    return v == .bool(true) || v == .string("true")
}


/// The tap and accessibility shared by Switch and Checkbox.
private struct ZnToggleTap: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let on: Bool
    let disabled: Bool
    let trait: AccessibilityTraits
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        let takes = !disabled && s.onValueChange != 0
        // A Button (it was an onTapGesture) for its pressed state: the halo shows while the finger is down, as
        // Android's ripple on finger down. Its taps are the same SwiftUI tap: up inside, a scroll that starts cancels it.
        Button {
            guard takes else { return }
            ctx.send(inst.id, s.onValueChange, .bool(!on))
        } label: {
            content
                .frame(minWidth: 48, minHeight: 48)
                .contentShape(Rectangle())
        }
        .buttonStyle(ZnToggleStyle(s: s, halo: takes))
        // Its frame while it takes taps: a see-through screen takes the tap here (ZnSeeThroughHolder).
        .background(ZnSeeThroughTapMarker(off: touchOff || disabled || s.onValueChange == 0))
        // And a box a Pressable around it leaves to it (ZnTouchControl.hitTest): the innermost control wins (A53,
        // Pavan 2026-11-24). In a tappable row the row took the tap and the Switch never turned; in a rail inside a
        // card the card was pressed too. A disabled one (or one with no onValueChange) leaves the tap to the row,
        // as Android, where it has no pointer input then.
        .background(ZnFieldBoxMarker(key: "toggle:" + ZnFieldFocus.key(inst, s.index),
                                     off: touchOff || disabled || s.onValueChange == 0))
        .accessibilityElement()
        .accessibilityAddTraits(trait)
        .accessibilityValue(on ? "1" : "0")
        // accessibilityLabel (also from a slot), hint and testID (ZnAccessibility.swift).
        .znFieldA11y(s, label: s.accessibilityLabelNow(inst))
        .environment(\.isEnabled, !disabled)  // VoiceOver reads a disabled one as "dimmed"
    }
}

/// Switch / Checkbox touch feedback, as Android's ZnRipple(bounded = false, radius = 20) on them (ZnSwitch.kt,
/// ZnCheckbox.kt): a round halo of radius 20 around the control's middle, black at 16 % (a `rippleColor` at its own
/// RGB; `rippleOpacity` wins), with the Pressable ripple's timings (ZnRippleTiming). None while it takes no taps
/// (disabled, or no onValueChange), as Android, which has no pointer input then. Inside a Scroll a quick tap shows
/// none: SwiftUI's Button gets its press only at the lift there, as UIKit's buttons.
private struct ZnToggleStyle: ButtonStyle {
    let s: ZnNodeSpec
    let halo: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay {
                if halo {
                    ZnToggleHalo(pressed: configuration.isPressed, color: znRippleColor(s.rippleColor),
                                 alpha: s.rippleOpacity ?? 0.16)
                }
            }
    }
}

private struct ZnToggleHalo: View {
    let pressed: Bool
    let color: Color
    let alpha: Double
    @State private var shown = false
    @State private var grown = false
    @State private var downAt = Date.distantPast

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 40, height: 40)
            .scaleEffect(grown ? 1 : 0.2)
            .opacity(shown ? alpha : 0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onChange(of: pressed) { _, down in
                if down {
                    downAt = Date()
                    var t = Transaction()
                    t.disablesAnimations = true
                    withTransaction(t) { grown = false }
                    withAnimation(.linear(duration: ZnRippleTiming.enter)) { shown = true }
                    withAnimation(.easeOut(duration: ZnRippleTiming.grow)) { grown = true }
                } else {
                    let wait = max(0, ZnRippleTiming.hold - Date().timeIntervalSince(downAt))
                    withAnimation(.easeOut(duration: ZnRippleTiming.exit).delay(wait)) { shown = false }
                }
            }
    }
}

struct ZnSwitchView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let on = znToggleValue(s, inst)
        let disabled = s.disabledNow(inst)
        let off = s.trackColor ?? Color(.sRGB, red: 0xD1 / 255, green: 0xD5 / 255, blue: 0xDB / 255)
        let track = on ? (s.activeTrackColor ?? znGreen) : off
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 10).fill(track).frame(width: 36, height: 20)
            Circle().fill(s.thumbColor ?? .white).frame(width: 16, height: 16).offset(x: on ? 18 : 2)
        }
        .frame(width: 36, height: 20)
        .opacity(disabled ? 0.38 : 1)
        .animation(.linear(duration: 0.15), value: on)
        .modifier(ZnToggleTap(ctx: ctx, s: s, inst: inst, on: on, disabled: disabled, trait: .isToggle))
    }
}

struct ZnCheckboxView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let on = znToggleValue(s, inst)
        let disabled = s.disabledNow(inst)
        let border = s.color ?? Color(.sRGB, red: 0x6B / 255, green: 0x72 / 255, blue: 0x80 / 255)
        let fill = s.activeColor ?? znGreen
        ZStack {
            RoundedRectangle(cornerRadius: 4).fill(fill).opacity(on ? 1 : 0)
            RoundedRectangle(cornerRadius: 4).inset(by: 1).stroke(border, lineWidth: 2).opacity(on ? 0 : 1)
            Canvas { g, size in
                var tick = Path()
                tick.move(to: CGPoint(x: size.width * 0.22, y: size.height * 0.50))
                tick.addLine(to: CGPoint(x: size.width * 0.42, y: size.height * 0.70))
                tick.addLine(to: CGPoint(x: size.width * 0.78, y: size.height * 0.30))
                g.stroke(tick, with: .color(.white), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            .opacity(on ? 1 : 0)
        }
        .frame(width: 20, height: 20)
        .opacity(disabled ? 0.38 : 1)
        .animation(.linear(duration: 0.15), value: on)
        .modifier(ZnToggleTap(ctx: ctx, s: s, inst: inst, on: on, disabled: disabled, trait: .isButton))
    }
}

struct ZnSpinnerView: View {
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let size = s.size ?? 24
        let color = (s.colorSlot >= 0 ? znColor(inst.slot(s.colorSlot).value) : s.color) ?? znGreen
        let line = min(max(size * 0.1, 2), 4)
        TimelineView(.animation) { t in
            let turn = t.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1) * 360
            Circle()
                .trim(from: 0, to: 0.75)
                .stroke(color, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(turn))
                .padding(line / 2)
        }
        .frame(width: size, height: size)
    }
}

struct ZnProgressView: View {
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let raw = s.valueSlot >= 0 ? inst.slot(s.valueSlot).value : s.props[Registry.Prop.value]
        let color = (s.colorSlot >= 0 ? znColor(inst.slot(s.colorSlot).value) : s.color) ?? znGreen
        let track = s.trackColor ?? Color(.sRGB, red: 0xE5 / 255, green: 0xE7 / 255, blue: 0xEB / 255)
        let height: CGFloat = if case .points(let h) = s.height { h } else { 4 }
        Group {
            if s.valueSlot >= 0 || raw != nil {
                let f: Double = switch raw {
                case .number(let n): n.isNaN ? 0 : min(max(n, 0), 1)
                case .string(let t): min(max(Double(t) ?? 0, 0), 1)
                default: 0
                }
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(track)
                        Capsule().fill(color).frame(width: g.size.width * f).opacity(f > 0 ? 1 : 0)
                    }
                    .animation(.linear(duration: 0.15), value: f)
                }
            } else {
                // No value: a bar 40 % wide sliding across, from just off the start to the end.
                TimelineView(.animation) { t in
                    Canvas { g, size in
                        let shift = t.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2 * 1.4 - 0.4
                        let r = size.height / 2
                        g.fill(Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: r), with: .color(track))
                        let x0 = min(max(size.width * shift, 0), size.width)
                        let x1 = min(max(size.width * (shift + 0.4), 0), size.width)
                        if x1 > x0 {
                            g.fill(Path(roundedRect: CGRect(x: x0, y: 0, width: x1 - x0, height: size.height), cornerRadius: r),
                                   with: .color(color))
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
    }
}
