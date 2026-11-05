// A dev screen for the RN-compat sweep (2026-11-05): React Native code written the RN way, which zero-native now builds
// as RN draws it. Each check logs one "rn-names ..." line. Written on purpose with RN names (View, FlatList,
// TouchableOpacity, marginLeft, "white", ...), as a migrated screen would be.
import {
  ActivityIndicator,
  FlatList,
  Image,
  Scroll,
  Text,
  TouchableHighlight,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "@zero-native/ui"
import { AsyncStorage, BackHandler, effect, signal, useNavigation, useRef } from "@zero-native/core"
import { c } from "./tokens"

const ROWS = [
  { id: "t1", name: "Annapoorna Tiffins", amount: "₹120" },
  { id: "t2", name: "Sri Sai Medicals", amount: "₹86" },
  { id: "t3", name: "Green Leaf Supermart", amount: "₹1,240" },
]

const s = {
  title: { fontSize: 15, fontWeight: 700, color: c.ink, marginTop: 8 },
  card: { padding: 12, borderRadius: 12, backgroundColor: "white", borderWidth: 1, borderColor: c.border },
  button: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, height: 48, borderRadius: 12 },
  // A Touchable is a Pressable, which lays out its children as a column (no flexDirection on it).
  touch: { justifyContent: "center", alignItems: "center", height: 48, borderRadius: 12 },
} as const

export function RnNamesLabScreen() {
  const navigation = useNavigation()
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`rn-names ${text}`)
    status.set(text)
  }
  const ticking = signal(false)
  const ticks = signal(0)
  const busy = signal(true)
  const saved = signal("(nothing)")
  const taps = useRef(0)
  const holdBack = signal(false)

  // P0.3: the returned function is the cleanup, as in React's useEffect.
  effect(() => {
    if (!ticking()) return
    say("tick start")
    const id = setInterval(() => ticks.set(ticks() + 1), 500)
    return () => {
      clearInterval(id)
      say(`tick stop at ${ticks()}`)
    }
  })
  BackHandler.addEventListener("hardwareBackPress", () => {
    if (!holdBack()) return false
    say("back kept by BackHandler")
    return true
  })

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ padding: 16, paddingBottom: 48, gap: 10 }}>
        <Text testID="rn-names-status" style={{ fontSize: 13, color: c.ink }}>
          {`status: ${status()}`}
        </Text>

        <Text style={s.title}>gap with justifyContent (P0.1)</Text>
        <View style={[s.button, { backgroundColor: c.primary }]}>
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: "white" }} />
          <Text style={{ color: "white", fontSize: 15, fontWeight: 600 }}>Scan to Pay</Text>
        </View>
        <View style={[s.card, { flexDirection: "row", justifyContent: "space-between", gap: 12 }]}>
          <Text style={{ flex: 1, fontSize: 13, color: c.ink }}>
            A long line of text next to a button, which must keep 12 dp away from it even when it wraps.
          </Text>
          <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: "hsl(152, 60%, 90%)" }}>
            <Text style={{ fontSize: 12, fontWeight: 600, color: "darkgreen" }}>Refer</Text>
          </View>
        </View>

        <Text style={s.title}>View, marginLeft, colour names, rowGap</Text>
        <View style={[s.card, { rowGap: 6 }]}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "tomato" }} />
            <Text style={{ marginLeft: 8, fontSize: 13, color: c.ink, textAlign: "left" }}>marginLeft: 8 after a dot</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 18 }}>
            <Text style={{ fontSize: 13, color: "slategray" }}>paddingLeft: 18, color "slategray"</Text>
          </View>
        </View>

        <Text style={s.title}>Touchables</Text>
        <TouchableOpacity testID="rn-opacity" onPress={() => say(`opacity tap ${++taps.current}`)} style={[s.touch, { backgroundColor: c.primary }]}>
          <Text style={{ color: "white", fontSize: 15, fontWeight: 600 }}>TouchableOpacity (dims)</Text>
        </TouchableOpacity>
        <TouchableHighlight testID="rn-highlight" underlayColor="#DDDDDD" onPress={() => say("highlight tap")} style={[s.touch, { backgroundColor: "white", borderWidth: 1, borderColor: c.border }]}>
          <Text style={{ color: c.ink, fontSize: 15, fontWeight: 600 }}>TouchableHighlight</Text>
        </TouchableHighlight>
        <TouchableWithoutFeedback testID="rn-nofeedback" onPress={() => say("no-feedback tap")}>
          <View style={[s.card, { alignItems: "center" }]}>
            <Text style={{ fontSize: 13, color: c.ink }}>TouchableWithoutFeedback (no feedback)</Text>
          </View>
        </TouchableWithoutFeedback>

        <Text style={s.title}>ActivityIndicator, effect cleanup</Text>
        <View style={[s.card, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
          <ActivityIndicator size="large" color={c.primary} animating={busy()} />
          <TouchableOpacity testID="rn-spinner" onPress={() => busy.set(!busy())} style={{ padding: 8 }}>
            <Text style={{ fontSize: 13, color: c.primary, fontWeight: 600 }}>{busy() ? "Stop spinner" : "Start spinner"}</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="rn-ticker" onPress={() => ticking.set(!ticking())} style={{ padding: 8 }}>
            <Text style={{ fontSize: 13, color: c.primary, fontWeight: 600 }}>{ticking() ? `Ticking ${ticks()}` : "Start ticker"}</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.title}>Image source, resizeMode</Text>
        <Image source={{ uri: "https://picsum.photos/id/292/600/240" }} resizeMode="cover" style={{ height: 120, borderRadius: 12 }} />

        <Text style={s.title}>FlatList renderItem / keyExtractor</Text>
        <View style={{ height: 180 }}>
          <FlatList
            data={ROWS}
            keyExtractor={(item) => item.id}
            showsVerticalScrollIndicator={false}
            initialNumToRender={10}
            style={{ flex: 1, rowGap: 8 }}
            renderItem={({ item, index }) => (
              <View style={[s.card, { flexDirection: "row", justifyContent: "space-between" }]}>
                <Text style={{ fontSize: 13, color: c.ink }}>{`${index + 1}. ${item.name}`}</Text>
                <Text style={{ fontSize: 13, fontWeight: 700, color: c.ink }}>{item.amount}</Text>
              </View>
            )}
          />
        </View>

        <Text style={s.title}>AsyncStorage, BackHandler, useNavigation</Text>
        <View style={[s.card, { gap: 8 }]}>
          <Text style={{ fontSize: 13, color: c.ink }}>{`saved: ${saved()}`}</Text>
          <TouchableOpacity
            testID="rn-async"
            onPress={async () => {
              await AsyncStorage.setItem("rn-names.last", new Date().toISOString().slice(11, 19))
              saved.set((await AsyncStorage.getItem("rn-names.last")) ?? "null")
              say(`async saved ${saved()}`)
            }}
          >
            <Text style={{ fontSize: 13, color: c.primary, fontWeight: 600 }}>Save the time with AsyncStorage</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="rn-holdback" onPress={() => holdBack.set(!holdBack())}>
            <Text style={{ fontSize: 13, color: c.primary, fontWeight: 600 }}>{holdBack() ? "Back is kept (tap to let go)" : "Keep Back on this screen"}</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="rn-goback" onPress={() => navigation.goBack()}>
            <Text style={{ fontSize: 13, color: c.primary, fontWeight: 600 }}>navigation.goBack()</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Scroll>
  )
}
