// A chat on <List inverted> (registry 19): newest message first in data, drawn at the bottom. The phone check reads the
// log lines "chat-lab ...", so keep their wording.
import { Column, List, Pressable, Row, Text } from "@zeronative/ui"
import { scheme, signal } from "@zeronative/core"
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
        inverted
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
      <Pressable onPress={add} alignItems="center" style={{ margin: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: c.primary }}>
        <Text fontSize={15} fontWeight={600} color={c.white}>
          Add message
        </Text>
      </Pressable>
    </Column>
  )
}
