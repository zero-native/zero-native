// Dev screen showcasing Milestone 3 Steps 3.7 (Small Components) & 3.8 (Accessibility Basics).
// Open via zn://sample/dev/components or the Dev screens hub.
// The testIDs ("comp-...") are what the iOS UI tests find (ios/SamplePackage/ZnSampleUITests/ComponentsTests.swift).
import {
  Box,
  Checkbox,
  Column,
  Image,
  Progress,
  Pressable,
  Row,
  Scroll,
  Sheet,
  Shimmer,
  Spinner,
  Switch,
  Text,
} from "@zeronative/ui"
import { nav, signal, toast } from "@zeronative/core"
import { c } from "./tokens"

const cardStyle = {
  padding: 16,
  borderRadius: 14,
  backgroundColor: c.white,
  borderWidth: 1,
  borderColor: c.border,
  gap: 12,
}

const rowBetweenStyle = {
  alignItems: "center",
  justifyContent: "space-between",
} as const

const sectionHeaderStyle = {
  fontSize: 16,
  fontWeight: 700,
  color: c.ink,
}

const labelStyle = {
  fontSize: 14,
  fontWeight: 600,
  color: c.ink,
}

const descStyle = {
  fontSize: 12,
  color: c.muted,
}

const actionButtonStyle = {
  paddingHorizontal: 14,
  paddingVertical: 8,
  borderRadius: 8,
  backgroundColor: c.success,
}

const actionButtonTextStyle = {
  fontSize: 13,
  fontWeight: 600,
  color: c.white,
}

const secondaryButtonStyle = {
  paddingHorizontal: 10,
  paddingVertical: 6,
  borderRadius: 6,
  backgroundColor: "#E5E7EB",
}

const secondaryButtonTextStyle = {
  fontSize: 12,
  fontWeight: 600,
  color: c.ink,
}

export function ComponentsScreen() {
  // Controlled signals
  const switchEnabled = signal(false)
  const switchDelayed = signal(false)
  const checkboxChecked = signal(false)
  const progressFraction = signal(0.4)
  // The sheet draws in its own window: a toast shown from it must still be visible (must-not-miss rule 8).
  const sheetOpen = signal(false)
  // iOS checks (2026-11-09): a sheet closed while it still slides in must close (UIKit dropped that dismiss: ZeroBill's
  // "Processing Secure Payment" stayed up; the log says "while it opens: closes when it has opened"), and a sheet whose
  // content grows or shrinks must follow it ("content now N pt tall: resize").
  const sheetMore = signal(false)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      {/* Top App Bar */}
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable
          testID="comp-back"
          accessibilityLabel="Back to dev menu"
          onPress={() => nav.back()}
          style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}
        >
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text testID="comp-title" fontSize={20} fontWeight={700} color={c.ink}>
          Components &amp; a11y
        </Text>
      </Row>

      <Scroll testID="comp-scroll" style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 20, paddingBottom: 40, gap: 16 }}>
          {/* Section 1: Switch */}
          <Column style={cardStyle}>
            <Text style={sectionHeaderStyle} accessibilityRole="header">
              Controlled Switch
            </Text>

            {/* Interactive */}
            <Row style={rowBetweenStyle}>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text style={labelStyle}>Interactive Switch</Text>
                <Text testID="comp-switch-state" style={descStyle}>
                  {switchEnabled() ? "State: ON (active)" : "State: OFF (inactive)"}
                </Text>
              </Column>
              <Switch
                testID="comp-switch"
                value={switchEnabled()}
                onValueChange={(next) => switchEnabled.set(next)}
              />
            </Row>

            {/* Rule 10: JS Ignores Tap */}
            <Row style={rowBetweenStyle}>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text style={labelStyle}>JS Ignores Tap (Rule 10)</Text>
                <Text style={descStyle}>Tapping sends event, but value stays false. Thumb must NOT slide.</Text>
              </Column>
              <Switch
                testID="comp-switch-ignored"
                value={false}
                onValueChange={() => {
                  /* Intentional no-op */
                }}
              />
            </Row>

            {/* Delayed Switch */}
            <Row style={rowBetweenStyle}>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text style={labelStyle}>300ms Delayed Toggle</Text>
                <Text style={descStyle}>Thumb moves only after 300ms delay.</Text>
              </Column>
              <Switch
                testID="comp-switch-delayed"
                value={switchDelayed()}
                onValueChange={(next) => {
                  setTimeout(() => switchDelayed.set(next), 300)
                }}
              />
            </Row>

            {/* Disabled Switches */}
            <Row style={rowBetweenStyle}>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text style={labelStyle}>Disabled Switches</Text>
                <Text style={descStyle}>38% alpha, ignores taps, TalkBack says disabled.</Text>
              </Column>
              <Row style={{ gap: 8, alignItems: "center" }}>
                <Switch testID="comp-switch-off-disabled" value={false} disabled />
                <Switch testID="comp-switch-on-disabled" value={true} disabled />
              </Row>
            </Row>
          </Column>

          {/* Section 2: Checkbox */}
          <Column style={cardStyle}>
            <Text style={sectionHeaderStyle} accessibilityRole="header">
              Controlled Checkbox
            </Text>

            <Row style={rowBetweenStyle}>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text style={labelStyle}>Interactive Checkbox</Text>
                <Text testID="comp-check-state" style={descStyle}>
                  {checkboxChecked() ? "State: Checked" : "State: Unchecked"}
                </Text>
              </Column>
              <Checkbox
                testID="comp-check"
                value={checkboxChecked()}
                onValueChange={(next) => checkboxChecked.set(next)}
              />
            </Row>

            <Row style={rowBetweenStyle}>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text style={labelStyle}>JS Ignores Tap (Rule 10)</Text>
                <Text style={descStyle}>Stays unchecked upon tap.</Text>
              </Column>
              <Checkbox
                testID="comp-check-ignored"
                value={false}
                onValueChange={() => {
                  /* No-op */
                }}
              />
            </Row>

            <Row style={rowBetweenStyle}>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text style={labelStyle}>Disabled Checkboxes</Text>
                <Text style={descStyle}>Disabled off &amp; on.</Text>
              </Column>
              <Row style={{ gap: 8, alignItems: "center" }}>
                <Checkbox testID="comp-check-off-disabled" value={false} disabled />
                <Checkbox testID="comp-check-on-disabled" value={true} disabled />
              </Row>
            </Row>
          </Column>

          {/* Section 3: Spinner */}
          <Column style={cardStyle}>
            <Text style={sectionHeaderStyle} accessibilityRole="header">
              Spinner (Draw Phase Continuous Rotation)
            </Text>
            <Text style={descStyle}>
              Runs with 0 recompositions per frame. Proportional stroke scaling.
            </Text>

            <Row style={{ gap: 24, alignItems: "center" }}>
              <Spinner size={16} />
              <Spinner size={24} />
              <Spinner size={36} />
              <Spinner size={24} color="#2563EB" />
              <Spinner size={24} color="#EA580C" />
            </Row>
          </Column>

          {/* Section 4: Progress Bar */}
          <Column style={cardStyle}>
            <Text style={sectionHeaderStyle} accessibilityRole="header">
              Progress Bar
            </Text>

            <Text testID="comp-progress-label" style={labelStyle}>Determinate (Value: {Math.round(progressFraction() * 100)}%)</Text>
            <Progress testID="comp-progress" value={progressFraction()} />

            <Row style={{ gap: 8, alignItems: "center" }}>
              <Pressable testID="comp-progress-10" onPress={() => progressFraction.set(0.1)} style={secondaryButtonStyle}>
                <Text style={secondaryButtonTextStyle}>10%</Text>
              </Pressable>
              <Pressable testID="comp-progress-40" onPress={() => progressFraction.set(0.4)} style={secondaryButtonStyle}>
                <Text style={secondaryButtonTextStyle}>40%</Text>
              </Pressable>
              <Pressable testID="comp-progress-75" onPress={() => progressFraction.set(0.75)} style={secondaryButtonStyle}>
                <Text style={secondaryButtonTextStyle}>75%</Text>
              </Pressable>
              <Pressable testID="comp-progress-100" onPress={() => progressFraction.set(1.0)} style={secondaryButtonStyle}>
                <Text style={secondaryButtonTextStyle}>100%</Text>
              </Pressable>
            </Row>

            <Text style={labelStyle}>Indeterminate Endless Bar</Text>
            <Progress />
          </Column>

          {/* Section 5: Synchronized Shimmer */}
          <Column style={cardStyle}>
            <Text style={sectionHeaderStyle} accessibilityRole="header">
              Synchronized Shimmer
            </Text>
            <Text style={descStyle}>
              All placeholder rows move in lockstep from shared clock. 0 recompositions per frame.
            </Text>

            <Row style={{ gap: 12, alignItems: "center" }}>
              <Shimmer style={{ width: 48, height: 48, borderRadius: 24 }} />
              <Column style={{ flex: 1, gap: 8 }}>
                <Shimmer style={{ width: "80%", height: 14, borderRadius: 6 }} />
                <Shimmer style={{ width: "50%", height: 12, borderRadius: 6 }} />
              </Column>
            </Row>

            <Row style={{ gap: 12, alignItems: "center" }}>
              <Shimmer style={{ width: 48, height: 48, borderRadius: 8 }} />
              <Column style={{ flex: 1, gap: 8 }}>
                <Shimmer style={{ width: "90%", height: 14, borderRadius: 6 }} />
                <Shimmer style={{ width: "40%", height: 12, borderRadius: 6 }} />
              </Column>
            </Row>
          </Column>

          {/* Section 6: Image Fallback & Shimmer */}
          <Column style={cardStyle}>
            <Text style={sectionHeaderStyle} accessibilityRole="header">
              Image Loading Shimmer &amp; Fallback
            </Text>

            <Column style={{ gap: 6 }}>
              <Text style={labelStyle}>Loading with shimmer</Text>
              <Image
                src="https://picsum.photos/id/1062/600/240"
                loading="shimmer"
                style={{ width: "100%", height: 120, borderRadius: 12 }}
              />
            </Column>

            <Column style={{ gap: 6 }}>
              <Text style={labelStyle}>Broken URL → fallback image</Text>
              <Text style={descStyle}>Shows the fallback after a 404, one request each, never loops.</Text>
              <Image
                src="https://zeronative.dev/nonexistent_image_404.png"
                testID="comp-image-fallback"
                fallbackSrc="https://picsum.photos/id/1080/600/240"
                accessibilityLabel="Fallback demo image"
                loading="shimmer"
                style={{ width: "100%", height: 120, borderRadius: 12 }}
              />
            </Column>
          </Column>

          {/* Section 7: Toast API */}
          <Column style={cardStyle}>
            <Text style={sectionHeaderStyle} accessibilityRole="header">
              Toast (Native Module)
            </Text>
            <Text style={descStyle}>
              Pill above nav insets &amp; keyboard. Polite TalkBack live region. Survives screen exit (owned: false).
            </Text>

            <Row style={{ gap: 8, alignItems: "center" }}>
              <Pressable
                testID="comp-toast-short"
                onPress={() => toast("Changes saved successfully")}
                style={actionButtonStyle}
              >
                <Text style={actionButtonTextStyle}>Short Toast</Text>
              </Pressable>

              <Pressable
                testID="comp-toast-long"
                onPress={() =>
                  toast(
                    "Payment of ₹400 to Blue Tokai completed successfully. Receipt has been saved to your account.",
                    { duration: "long" }
                  )
                }
                style={actionButtonStyle}
              >
                <Text style={actionButtonTextStyle}>Long Toast (2 lines)</Text>
              </Pressable>
            </Row>

            <Pressable
              testID="comp-toast-back"
              onPress={() => {
                toast("Saved before leaving")
                nav.back()
              }}
              style={actionButtonStyle}
            >
              <Text style={actionButtonTextStyle}>Toast &amp; nav.back()</Text>
            </Pressable>

            <Pressable testID="comp-sheet-open" onPress={() => sheetOpen.set(true)} style={actionButtonStyle}>
              <Text style={actionButtonTextStyle}>Toast from inside a sheet</Text>
            </Pressable>

            <Pressable
              testID="comp-sheet-early"
              onPress={() => {
                const t0 = Date.now()
                console.log("sheet-close-early: open")
                sheetOpen.set(true)
                setTimeout(() => {
                  console.log("sheet-close-early: close after " + (Date.now() - t0) + " ms")
                  sheetOpen.set(false)
                }, 500)
              }}
              style={actionButtonStyle}
            >
              <Text style={actionButtonTextStyle}>Sheet: close while it slides in</Text>
            </Pressable>
          </Column>

          {/* Section 8: Accessibility Basics & maxFontScale */}
          <Column style={cardStyle}>
            <Text style={sectionHeaderStyle} accessibilityRole="header">
              Accessibility &amp; Font Scaling
            </Text>

            {/* accessibilityLabel dynamic replacement */}
            <Pressable
              testID="comp-a11y-label"
              accessibilityLabel="Custom accessibility label for TalkBack"
              accessibilityHint="Tap to activate this button"
              style={{
                padding: 12,
                borderRadius: 8,
                backgroundColor: "#F3F4F6",
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <Text style={labelStyle}>Visible text: Press Me</Text>
              <Text style={descStyle}>TalkBack reads: "Custom accessibility label for TalkBack"</Text>
            </Pressable>

            {/* accessibilityRole="none" */}
            <Pressable
              testID="comp-role-none"
              accessibilityRole="none"
              onPress={() => toast("Tapped role:none pressable")}
              style={{
                padding: 12,
                borderRadius: 8,
                backgroundColor: "#F3F4F6",
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <Text style={labelStyle}>Pressable with accessibilityRole="none"</Text>
              <Text style={descStyle}>Removes button announcement, double-tap still triggers onPress.</Text>
            </Pressable>

            {/* accessibilityHidden */}
            <Box
              testID="comp-hidden"
              accessibilityHidden
              style={{
                padding: 12,
                borderRadius: 8,
                backgroundColor: "#FEF3C7",
              }}
            >
              <Text style={{ fontSize: 13, color: "#92400E", fontWeight: 600 }}>
                This card is accessibilityHidden: true. TalkBack skips it completely.
              </Text>
            </Box>

            {/* maxFontScale */}
            <Column style={{ gap: 4 }}>
              <Text style={labelStyle}>maxFontScale comparison:</Text>
              <Text testID="comp-font-uncapped" fontSize={15} color={c.ink}>
                Uncapped Text: grows with system font size setting without limit.
              </Text>
              <Text testID="comp-font-capped" fontSize={15} maxFontScale={1.15} color={c.ink}>
                Capped Text (maxFontScale=1.15): caps scaling locally to preserve layout.
              </Text>
              <Text testID="comp-font-spans" fontSize={15} maxFontScale={1.15} color={c.ink}>
                Capped with spans: a <Text fontWeight={700}>bold span</Text> and a{" "}
                <Text fontSize={18} color={c.primary}>bigger span</Text>.
              </Text>
            </Column>
          </Column>
        </Column>
      </Scroll>

      <Sheet visible={sheetOpen()} onDismiss={() => sheetOpen.set(false)} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
        <Text testID="comp-sheet-title" fontSize={18} fontWeight={700} color={c.ink}>
          UPI ID: store@upi
        </Text>
        <Pressable testID="comp-sheet-copy" onPress={() => toast("UPI ID copied")} style={actionButtonStyle}>
          <Text style={actionButtonTextStyle}>Copy UPI ID</Text>
        </Pressable>
        <Pressable testID="comp-sheet-more" onPress={() => sheetMore.set(!sheetMore())} style={actionButtonStyle}>
          <Text style={actionButtonTextStyle}>{sheetMore() ? "Fewer lines" : "More lines (the sheet grows)"}</Text>
        </Pressable>
        {sheetMore() ? (
          <Text testID="comp-sheet-lines" fontSize={14} color={c.ink}>
            Line one{"\n"}Line two{"\n"}Line three{"\n"}Line four
          </Text>
        ) : null}
      </Sheet>
    </Column>
  )
}
