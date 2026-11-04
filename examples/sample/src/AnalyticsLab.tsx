// A dev screen for the Analytics plugin. The phone test (tools/plugin-phone/analytics.ts) reads the log lines
// "analytics-lab ...", so keep their wording. Analytics starts on: "Collection off" is the user's opt-out.
import { Column, Pressable, Scroll, Text } from "@zero-native/ui"
import { nav, scheme, signal } from "@zero-native/core"
import { Analytics } from "@zero-native/analytics"
import { c } from "./tokens"

function AnalyticsLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function AnalyticsLabLine(props: { text: string }) {
  return (
    <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
      {props.text}
    </Text>
  )
}

export function AnalyticsLabScreen() {
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`analytics-lab ${text}`)
    status.set(text)
  }

  const readStatus = () => Analytics.status().then((s) => say(`status available=${s.available}`))
  void readStatus()

  const collection = (on: boolean) =>
    Analytics.setAnalyticsCollectionEnabled(on).then((ok) => say(`collection ${on ? "on" : "off"} ok=${ok}`))

  const logEvent = () =>
    Analytics.logEvent("zn_lab_tap", { amount: 499, method: "upi", first: true }).then((ok) => say(`event sent=${ok}`))

  const logBadName = () => Analytics.logEvent("lab-bad-name").then((ok) => say(`bad name sent=${ok}`))

  const logPurchase = () =>
    Analytics.logPurchase({
      value: 499,
      currency: "INR",
      transaction_id: "lab-txn-1",
      items: [{ item_id: "lab-sku-1", item_name: "Lab item", price: 499, quantity: 1 }],
    }).then((ok) => say(`purchase sent=${ok}`))

  const setUser = async () => {
    const a = await Analytics.setUserId("lab-user-1")
    const b = await Analytics.setUserProperty("lab_plan", "free")
    say(`user set ok=${a && b}`)
  }

  const instanceId = () => Analytics.getAppInstanceId().then((id) => say(`instance id ${id ? id.length : 0}`))

  const consent = (granted: boolean) =>
    Analytics.setConsent({ analytics_storage: granted, ad_storage: false, ad_user_data: false, ad_personalization: false }).then(
      (ok) => say(`consent analytics=${granted} ok=${ok}`),
    )

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <AnalyticsLabLine text={`status: ${status()}`} />
        <AnalyticsLabButton label="Read status" onPress={() => void readStatus()} />
        <AnalyticsLabButton label="Collection on" onPress={() => void collection(true)} />
        <AnalyticsLabButton label="Collection off" onPress={() => void collection(false)} />
        <AnalyticsLabButton label="Consent granted" onPress={() => void consent(true)} />
        <AnalyticsLabButton label="Log an event" onPress={() => void logEvent()} />
        <AnalyticsLabButton label="Log a bad name" onPress={() => void logBadName()} />
        <AnalyticsLabButton label="Log a purchase" onPress={() => void logPurchase()} />
        <AnalyticsLabButton label="Set user and property" onPress={() => void setUser()} />
        <AnalyticsLabButton label="App instance id" onPress={() => void instanceId()} />
        <AnalyticsLabButton label="Open the Crashlytics lab" onPress={() => nav.push("crashlyticsLab")} />
        <AnalyticsLabLine text="Screen views go by themselves, one per screen. Events show in DebugView with debug mode on." />
      </Column>
    </Scroll>
  )
}
