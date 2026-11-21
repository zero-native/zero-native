// RN gaps pack (registry 24): <FlatList numColumns> grids. Logs "grid-lab ..." lines (range, end reached) so a phone
// check can read them; keep their wording. Pull the grid down: a white spinner on a primary-colour disc (RN's
// RefreshControl tintColor + progressBackgroundColor) for 1.5 s.
import { Column, FlatList, Pressable, RefreshControl, Row, Text } from "@zeronative/ui"
import { listController, signal } from "@zeronative/core"
import { c } from "./tokens"

interface Store {
  id: string
  name: string
  cashback: number
}

const NAMES = ["Ravi Stores", "Fresh Mart", "Hotel Annapurna", "Sri Medicals", "City Bakery", "Style Salon", "Metro Fuel", "Book Nook"]
const COLORS = ["#EEF2FF", "#ECFDF5", "#FFF7ED", "#FDF2F8", "#F0F9FF", "#FEFCE8"]

function makeStores(from: number, count: number): Store[] {
  return Array.from({ length: count }, (_, k) => {
    const i = from + k
    return { id: `s${i}`, name: `${NAMES[i % NAMES.length]} ${i + 1}`, cashback: 5 + ((i * 7) % 40) }
  })
}

function GridButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={12} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

/** A store card: flex 1, so the items of a row share it (RN's usual grid item). */
function GridStoreCard(props: { s: Store; index: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      style={{ flex: 1, borderRadius: 14, padding: 12, gap: 6, backgroundColor: COLORS[props.index % COLORS.length] }}
    >
      <Text fontSize={13} fontWeight={700} color={c.ink} numberOfLines={1}>
        {props.s.name}
      </Text>
      <Text fontSize={20} fontWeight={800} color={c.primary}>{`${props.s.cashback}%`}</Text>
      <Text fontSize={11} color={c.muted}>cashback</Text>
    </Pressable>
  )
}

export function GridLabScreen() {
  const stores = signal<Store[]>(makeStores(0, 41)) // 41: the last row is short in 2 and 3 columns
  const cols = signal(2)
  const tapped = signal("tap a card")
  const half = signal(false)
  const list = listController()
  const refreshing = signal(false)
  const refresh = () => {
    console.info("grid-lab refresh")
    refreshing.set(true)
    setTimeout(() => refreshing.set(false), 1500)
  }
  const loadMore = () => {
    const n = stores().length
    console.info(`grid-lab end reached at ${n}`)
    if (n < 119) stores.set([...stores(), ...makeStores(n, Math.min(20, 119 - n))]) // 119: a short last row
  }
  const header = (
    <Column gap={8} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
      <Text testID="grid-title" fontSize={18} fontWeight={800} color={c.ink}>
        Grid lab
      </Text>
      <Text fontSize={12} color={c.muted}>{`${stores().length} stores, ${cols()} columns. ${tapped()}`}</Text>
      <Row gap={8} style={{ flexWrap: "wrap" }}>
        <GridButton label={cols() === 2 ? "3 columns" : "2 columns"} onPress={() => cols.set(cols() === 2 ? 3 : 2)} />
        <GridButton label="Scroll to 30" onPress={() => list.scrollToIndex({ index: 30, animated: true })} />
        <GridButton label="Empty" onPress={() => stores.set([])} />
        <GridButton label="Reset" onPress={() => stores.set(makeStores(0, 41))} />
        <GridButton label={half() ? "flex: 1 items" : "48% + space-between"} onPress={() => half.set(!half())} />
      </Row>
    </Column>
  )
  const footer = (
    <Text fontSize={12} color={c.muted} style={{ padding: 16, textAlign: "center" }}>
      {stores().length >= 119 ? "That's all (119)" : "Loading more near the end…"}
    </Text>
  )
  const empty = (
    <Text fontSize={14} color={c.muted} style={{ padding: 32, textAlign: "center" }}>
      No stores. Tap Reset.
    </Text>
  )
  return half() ? (
    <FlatList
      style={{ flex: 1, backgroundColor: c.white }}
      data={stores()}
      keyExtractor={(s) => s.id}
      numColumns={2}
      columnWrapperStyle={{ justifyContent: "space-between", paddingHorizontal: 16 }}
      gap={12}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      renderItem={({ item, index }) => (
        <Pressable
          onPress={() => tapped.set(`tapped ${item.name}`)}
          style={{ width: "48%", borderRadius: 14, padding: 12, backgroundColor: COLORS[index % COLORS.length] }}
        >
          <Text fontSize={13} fontWeight={700} color={c.ink}>{item.name}</Text>
          <Text fontSize={11} color={c.muted}>{`48% wide, ${item.cashback}%`}</Text>
        </Pressable>
      )}
    />
  ) : (
    <FlatList
      style={{ flex: 1, backgroundColor: c.white }}
      data={stores()}
      keyExtractor={(s) => s.id}
      numColumns={cols()}
      columnWrapperStyle={{ gap: 12, paddingHorizontal: 16 }}
      gap={12}
      ref={list}
      onEndReached={loadMore}
      refreshControl={<RefreshControl refreshing={refreshing()} onRefresh={refresh} tintColor={c.white} progressBackgroundColor={c.primary} />}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      renderItem={({ item, index }) => <GridStoreCard s={item} index={index} onPress={() => tapped.set(`tapped ${item.name}`)} />}
    />
  )
}
