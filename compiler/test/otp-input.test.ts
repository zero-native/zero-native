// <OtpInput> (registry 18, guide notes §62): react-native-otp-entry's props compile to one node.
import { describe, expect, test } from "bun:test"
import type { NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"

function compile(jsx: string) {
  const specs: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => specs.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (specs[id] = s),
  }
  const { code } = compileModule(`import { createRef } from "@zero-native/core"\nconst r = createRef()\nfunction A(p) { return ${jsx} }`, "a.tsx", ctx)
  return { props: specs[0]!.props as Record<string, unknown>, code }
}
const err = (jsx: string) => {
  try {
    compile(jsx)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

describe("OtpInput", () => {
  test("the RN customer app's Verify screen, prop for prop", () => {
    const { props, code } = compile(`<OtpInput ref={r} numberOfDigits={4} focusColor={'#006E67'} autoFocus={false} type="numeric"
      blurOnFilled disabled={p.verifying()} onTextChange={(t) => p.change(t)} onFilled={(c) => p.verify(c)}
      textInputProps={{ accessibilityLabel: 'One-Time Password', keyboardType: 'number-pad', autoComplete: 'sms-otp', textContentType: 'oneTimeCode' }}
      theme={{
        containerStyle: { width: 264, gap: 8, justifyContent: 'center' },
        pinCodeContainerStyle: { width: 60, height: 64, borderRadius: 12, borderWidth: 1.5, borderColor: '#E5E7EB', backgroundColor: '#F9FAFB' },
        focusedPinCodeContainerStyle: { borderColor: '#006E67', borderWidth: 2 },
        disabledPinCodeContainerStyle: { backgroundColor: '#F9FAFB' },
        pinCodeTextStyle: { fontSize: 24, fontWeight: '700', color: '#1F2937' },
        focusStickStyle: { backgroundColor: '#006E67', height: 24, width: 2 },
      }} />`)
    expect(props).toMatchObject({
      maxLength: 4, otpType: "numeric", keyboardType: "number-pad", autoComplete: "sms-otp", blurOnFilled: true,
      accessibilityLabel: "One-Time Password", width: 264, gap: 8, justifyContent: "center",
      fontSize: 24, fontWeight: 700, color: "#1F2937",
      otpTheme: "fc=#FF006E67;w=60;h=64;r=12;bw=1.5;bc=#FFE5E7EB;bg=#FFF9FAFB;fbc=#FF006E67;fbw=2;dbg=#FFF9FAFB;sc=#FF006E67;sh=24;sw=2",
    })
    expect(props.autoFocus).toBeUndefined() // autoFocus={false}
    expect(props.disabled).toMatchObject({ $slot: expect.any(String) }) // changes at runtime
    expect(props.onChangeText).toMatchObject({ $event: expect.any(String) })
    expect(props.onFilled).toMatchObject({ $event: expect.any(String) })
    // ref: the handle and the value slot that carries setValue.
    expect(code).toMatch(/__zn\.otpRef\(__i0, \d+, \d+, r\)/)
  })

  test("react-native-otp-entry's defaults", () => {
    expect(compile(`<OtpInput />`).props).toEqual({ maxLength: 6, otpType: "numeric", keyboardType: "number-pad", autoComplete: "sms-otp", autoFocus: true })
    expect(compile(`<OtpInput type="alpha" />`).props).toMatchObject({ otpType: "alpha", keyboardType: "default" })
    expect(compile(`<OtpInput textInputProps={{ autoComplete: "one-time-code" }} />`).props).toMatchObject({ autoComplete: "sms-otp" })
    expect(compile(`<OtpInput hideStick focusStickBlinkingDuration={500} />`).props).toMatchObject({ otpTheme: "hs=1;sb=500" })
  })

  test("error, disabled and placeholder can change at runtime", () => {
    const { props } = compile(`<OtpInput error={p.wrong()} disabled placeholder={p.ph()} />`)
    expect(props.invalid).toMatchObject({ $slot: expect.any(String) })
    expect(props.disabled).toBe(true)
    expect(props.placeholder).toMatchObject({ $slot: expect.any(String) })
  })

  test("build errors that say what to write", () => {
    expect(err(`<OtpInput style={{ width: 200 }} />`)).toMatch(/theme\.containerStyle/)
    expect(err(`<OtpInput numberOfDigits={p.n} />`)).toMatch(/numberOfDigits must be known at build time/)
    expect(err(`<OtpInput numberOfDigits={0} />`)).toMatch(/whole number from 1 to 12/)
    expect(err(`<OtpInput type="hex" />`)).toMatch(/type needs one of numeric, alpha, alphanumeric/)
    expect(err(`<OtpInput theme={{ pinCodeContainerStyle: { width: p.w } }} />`)).toMatch(/must be known at build time/)
    expect(err(`<OtpInput theme={{ pinCodeContainerStyle: { margin: 4 } }} />`)).toMatch(/a box takes width, height, borderRadius/)
    expect(err(`<OtpInput theme={{ pinCodeTextStyle: { lineHeight: 30 } }} />`)).toMatch(/the digits take fontSize/)
    expect(err(`<OtpInput theme={{ pinCodeContainerStyle: { borderColor: "nope" } }} />`)).toMatch(/borderColor/)
    expect(err(`<OtpInput textInputProps={{ maxLength: 4 }} />`)).toMatch(/textInputProps\.maxLength isn't supported/)
    expect(err(`<OtpInput textProps={{}} />`)).toMatch(/theme\.pinCodeTextStyle/)
    expect(err(`<OtpInput focusColor={p.c} />`)).toMatch(/focusColor must be known at build time/)
    expect(err(`<OtpInput>x</OtpInput>`)).toMatch(/takes no children/)
  })
})
