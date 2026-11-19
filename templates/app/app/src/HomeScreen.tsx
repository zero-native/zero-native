// The start screen (route "/"): a counter, and a button to the second screen.
import { Pressable, Text, View } from "@zeronative/ui"
import { nav, signal } from "@zeronative/core"
import { s } from "./theme"

export function HomeScreen() {
  // A signal: when it changes, only the text that reads it is drawn again.
  const count = signal(0)

  return (
    <View style={s.screen}>
      <Text style={s.title}>__APP_TITLE__</Text>
      <Text style={s.body}>Edit app/src/HomeScreen.tsx, then build again.</Text>
      <View style={s.card}>
        <Text style={s.body}>You pressed the button</Text>
        <Text style={s.title}>{count()} times</Text>
        <Pressable onPress={() => count.set(count() + 1)} style={s.button}>
          <Text style={s.buttonText}>Press me</Text>
        </Pressable>
      </View>
      <Pressable onPress={() => nav.push("about", { from: "home" })} style={s.outline}>
        <Text style={s.outlineText}>Open the second screen</Text>
      </Pressable>
    </View>
  )
}
