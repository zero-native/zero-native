// A chat on <List inverted> (registry 19): newest message first in data, drawn at the bottom. The phone check reads the
// log lines "chat-lab ...", so keep their wording. ListHeaderComponent sits next to the newest message (at the bottom)
// and ListFooterComponent past the oldest (at the top), as RN flips the whole list; "Newest" is a ref's
// scrollToIndex(0), which lands on the bottom.
import { Column, List, Pressable, Row, Text } from "@zeronative/ui"
import { listController, scheme, signal } from "@zeronative/core"
import { c } from "./tokens"

interface Message {
  id: number
  text: string
  mine: boolean
}

let nextId = 1
const make = (n: number): Message[] =>
  Array.from({ length: n }, () => {
    const id = nextId++
    return { id, text: `Message ${id}`, mine: id % 3 === 0 }
  })

export function ChatListLabScreen() {
  // Newest first: index 0 is the bottom of the chat.
  const messages = signal<Message[]>(make(60).reverse())
  const list = listController()
  const add = () => {
    const [m] = make(1)
    messages.set([m!, ...messages()])
    console.info(`chat-lab added ${m!.id}`)
  }
  const older = () => {
    if (messages().length >= 150) return
    const more = make(30).map((m) => ({ ...m, id: -m.id, text: `Older ${m.id}` }))
    messages.set([...messages(), ...more])
    console.info(`chat-lab older ${messages().length}`)
  }
  return (
    <Column style={{ flex: 1, backgroundColor: scheme("#F2F4F7", "#202020") }}>
      <List
        data={messages()}
        key={(m) => String(m.id)}
        controller={list}
        inverted
        ListHeaderComponent={
          <Text fontSize={12} color={c.muted} style={{ paddingHorizontal: 4 }}>
            Ravi is typing…
          </Text>
        }
        ListFooterComponent={
          <Text fontSize={12} color={c.muted} style={{ padding: 8, textAlign: "center" }}>
            {messages().length >= 150 ? "Start of the chat" : "Scroll up for older messages"}
          </Text>
        }
        gap={6}
        onEndReached={older}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 12 }}
        row={(m) => (
          <Row>
            {m.mine && <Column style={{ flex: 1 }} />}
            <Text
              fontSize={15}
              color={m.mine ? "#FFFFFF" : "#101828"}
              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: m.mine ? c.primary : "#FFFFFF" }}
            >
              {m.text}
            </Text>
          </Row>
        )}
      />
      <Row gap={8} style={{ margin: 12 }}>
        <Pressable onPress={add} alignItems="center" style={{ flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: c.primary }}>
          <Text fontSize={15} fontWeight={600} color={c.white}>
            Add message
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            console.info("chat-lab newest")
            list.scrollToIndex({ index: 0, animated: true })
          }}
          alignItems="center"
          style={{ paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, backgroundColor: c.primary }}
        >
          <Text fontSize={15} fontWeight={600} color={c.white}>
            Newest
          </Text>
        </Pressable>
      </Row>
    </Column>
  )
}
