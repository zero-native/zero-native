// A dev screen for <OtpInput> (registry 18, guide notes §62). The first one copies the RN customer app's Verify screen
// prop for prop (AuthVerifyScreen.tsx), so the two can be put side by side. Each action logs one "otp-lab ..." line.
import { Column, OtpInput, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { createRef, signal, type OtpInputHandle } from "@zero-native/core"
import { c } from "./tokens"

function OtpButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function OtpLabScreen() {
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`otp-lab ${text}`)
    status.set(text)
  }
  const verifying = signal(false)
  const wrong = signal(false)
  const otp = createRef<OtpInputHandle>()

  return (
    <Scroll style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text testID="otp-status" fontSize={13} color={c.muted}>
        {status()}
      </Text>

      {/* The RN customer app's OtpInput, as written there. */}
      <Text fontSize={15} fontWeight={700} color={c.ink}>
        As the RN Verify screen
      </Text>
      <Column alignItems="center">
        <OtpInput
          ref={otp}
          numberOfDigits={4}
          focusColor={"#006E67"}
          autoFocus
          type="numeric"
          blurOnFilled
          disabled={verifying()}
          error={wrong()}
          onTextChange={(t) => say(`change ${t}`)}
          onFilled={(code) => say(`filled ${code}`)}
          onFocus={() => say("focus")}
          onBlur={() => say("blur")}
          textInputProps={{
            accessibilityLabel: "One-Time Password",
            keyboardType: "number-pad",
            autoComplete: "sms-otp",
            textContentType: "oneTimeCode",
            testID: "otp-rn",
          }}
          theme={{
            containerStyle: { width: 264, gap: 8, justifyContent: "center" },
            pinCodeContainerStyle: {
              width: 60,
              height: 64,
              borderRadius: 12,
              borderWidth: 1.5,
              borderColor: "#E5E7EB",
              backgroundColor: "#F9FAFB",
            },
            focusedPinCodeContainerStyle: { borderColor: "#006E67", borderWidth: 2 },
            disabledPinCodeContainerStyle: { backgroundColor: "#F9FAFB" },
            errorPinCodeContainerStyle: { borderColor: "#DC2626", backgroundColor: "#FEF2F2" },
            pinCodeTextStyle: { fontSize: 24, fontWeight: "700", color: "#1F2937" },
            focusStickStyle: { backgroundColor: "#006E67", height: 24, width: 2 },
          }}
        />
      </Column>
      <Row gap={8}>
        <OtpButton label="SMS 4821" onPress={() => otp.current?.setValue("4821")} />
        <OtpButton label="Fill 12 34 56" onPress={() => otp.current?.setValue("12 34 56")} />
      </Row>
      <Row gap={8}>
        <OtpButton label="Clear + focus" onPress={() => { otp.current?.clear(); otp.current?.focus() }} />
        <OtpButton label="Blur" onPress={() => otp.current?.blur()} />
      </Row>
      <Row gap={8}>
        <OtpButton label={verifying() ? "Enable" : "Disable"} onPress={() => verifying.set(!verifying())} />
        <OtpButton label={wrong() ? "No error" : "Wrong OTP"} onPress={() => wrong.set(!wrong())} />
      </Row>

      {/* react-native-otp-entry's defaults: 6 boxes, space-between, a placeholder. */}
      <Text fontSize={15} fontWeight={700} color={c.ink}>
        Defaults, 6 boxes, placeholder
      </Text>
      <OtpInput autoFocus={false} placeholder="•" onFilled={(code) => say(`six ${code}`)} textInputProps={{ testID: "otp-six" }} />

      <Text fontSize={15} fontWeight={700} color={c.ink}>
        Letters and digits, hidden
      </Text>
      <OtpInput
        numberOfDigits={5}
        type="alphanumeric"
        secureTextEntry
        autoFocus={false}
        focusColor="#4F46E5"
        onFilled={(code) => say(`code ${code.length} chars`)}
        textInputProps={{ testID: "otp-alnum" }}
      />
    </Scroll>
  )
}
