import { Column, Text } from "@zero-native/ui"

export function BScreen(props: { on: boolean }) {
  return (
    <Column>
      <Text>B</Text>
      {props.on && <Text>on</Text>}
    </Column>
  )
}
