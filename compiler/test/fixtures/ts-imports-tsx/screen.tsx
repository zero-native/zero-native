import { Column, Text } from "@zeronative/ui"
import { Badge, GAP } from "./parts"
import { PAD } from "./tokens"

export function HomeScreen() {
  return (
    <Column gap={GAP} padding={PAD}>
      <Text>Home</Text>
      <Badge label="new" />
    </Column>
  )
}
