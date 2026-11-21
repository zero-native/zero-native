import { List, Pressable, Text } from "@zeronative/ui"

export function Tasks(p: { rows: { id: string; title: string }[]; move(a: number, b: number): void; menu(id: string): void }) {
  return (
    <List data={p.rows} key={(r) => r.id} reorderable onReorder={(a, b) => p.move(a, b)}
      row={(r) => (
        <Pressable onLongPress={() => p.menu(r.id)}>
          <Text>{r.title}</Text>
        </Pressable>
      )} />
  )
}
