// The second screen (route "about"). Its params come from nav.push("about", { from }) or from a link's query.
import { Pressable, Text, View } from "@zeronative/ui"
import { nav } from "@zeronative/core"
import { s } from "./theme"

export function AboutScreen(props: { from?: string }) {
  return (
    <View style={s.screen}>
      <Text style={s.title}>Second screen</Text>
      <Text style={s.body}>Opened from: {props.from ?? "nowhere"}</Text>
      <Text style={s.body}>Back (the system's back, or the button) returns to the first screen.</Text>
      <Pressable onPress={() => nav.back()} style={s.button}>
        <Text style={s.buttonText}>Back</Text>
      </Pressable>
    </View>
  )
}
