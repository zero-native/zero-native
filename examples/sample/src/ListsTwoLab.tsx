// Lists lab 2 (/dev/lists2, registry 24): what a <List> does past its rows. It is an example, not framework code.
//   a) Animate: rows added, removed and moved with itemAnimation "fade" or "move" (tap a row to remove it)
//   b) Reorder: long press a row, drag it, drop it; "JS says no" keeps JS's order (the row goes back after 1 s). The
//      rows have an onLongPress that must NOT run (a reorderable List's long press is the pick-up, decision 7)
//   c) Scroll: snapToInterval on rows, decelerationRate, onScroll / drag / momentum log, keyboardDismissMode on-drag,
//      scrollToIndex with viewOffset, scrollToOffset
//   d) Pinned: stickyHeaderIndices + pull to refresh (its y stays 0 at rest while refreshing), and an inverted chat
//      (for ZN_IOS_LIST=swiftui too)
//   e) More: a sideways List with only a ref (its commands go along x), and an inverted List that snaps to 60 dp rows
//      (a fling down goes to older rows, its momentum speed is + toward older rows)
//   b) also: the header's onLongPress DOES run (only rows are picked up), and "Add 3 in 2 s" adds rows while a drag
//      may be under way (they go in when it ends)
// Each change is logged as "lists2 ..." in the console.
import { Column, List, Pressable, Row, Text, TextField } from "@zeronative/ui"
import { listController, nav, signal } from "@zeronative/core"
import { c } from "./tokens"

function L2Button(props: { label: string; onPress: () => void; on?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, backgroundColor: props.on ? c.primary : c.pillBg }}
    >
      <Text fontSize={12} fontWeight={700} color={props.on ? c.white : c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

interface L2Item {
  id: string
  name: string
  tint: string
}

const TINTS = ["#FDE68A", "#BFDBFE", "#BBF7D0", "#FBCFE8", "#DDD6FE", "#FED7AA", "#A5F3FC", "#E5E7EB"]
const START: L2Item[] = Array.from({ length: 8 }, (_, i) => ({ id: `r${i + 1}`, name: `Row ${i + 1}`, tint: TINTS[i % TINTS.length] }))
let made = START.length

function L2Row(props: { item: L2Item; note: string; onPress: () => void; onLongPress?: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      style={{ height: 64, marginHorizontal: 16, marginVertical: 4, borderRadius: 12, backgroundColor: props.item.tint, paddingHorizontal: 16, justifyContent: "center" }}
    >
      <Text fontSize={15} fontWeight={700} color={c.ink}>
        {props.item.name}
      </Text>
      <Text fontSize={11} color={c.muted}>
        {props.note}
      </Text>
    </Pressable>
  )
}

// ---- a) Animate ----------------------------------------------------------------------------------------------------

function L2Animate() {
  const mode = signal<"fade" | "move">("fade")
  const items = signal<L2Item[]>(START)
  const set = (next: L2Item[], what: string) => {
    items.set(next)
    console.log(`lists2 animate ${mode()}: ${what} → ${next.map((i) => i.id).join(",")}`)
  }
  const add = () => {
    made++
    set([{ id: `r${made}`, name: `Row ${made} (new)`, tint: TINTS[made % TINTS.length] }, ...items()], "add at top")
  }
  const addMid = () => {
    made++
    const list = items().slice()
    list.splice(2, 0, { id: `r${made}`, name: `Row ${made} (new)`, tint: TINTS[made % TINTS.length] })
    set(list, "add at 3")
  }
  const lastToTop = () => {
    const list = items().slice()
    const last = list.pop()
    if (last) set([last, ...list], "last to top")
  }
  const shuffle = () => {
    const list = items().slice()
    // A fixed shuffle (reverse pairs), so a run is the same each time.
    for (let i = 0; i + 1 < list.length; i += 2) [list[i], list[i + 1]] = [list[i + 1], list[i]]
    set(list, "swap pairs")
  }
  const remove = (id: string) => set(items().filter((i) => i.id !== id), `remove ${id}`)
  return (
    <Column style={{ flex: 1 }}>
      <Row style={{ gap: 6, paddingHorizontal: 16, paddingBottom: 8, flexWrap: "wrap" }}>
        <L2Button label="Fade" on={mode() === "fade"} onPress={() => mode.set("fade")} />
        <L2Button label="Move" on={mode() === "move"} onPress={() => mode.set("move")} />
        <L2Button label="Add top" onPress={add} />
        <L2Button label="Add at 3" onPress={addMid} />
        <L2Button label="Last to top" onPress={lastToTop} />
        <L2Button label="Swap pairs" onPress={shuffle} />
        <L2Button label="Reset" onPress={() => set(START, "reset")} />
      </Row>
      {mode() === "fade" ? (
        <List data={items()} key={(i) => i.id} itemAnimation="fade" style={{ flex: 1 }} row={(item) => <L2Row item={item} note="Fade: tap to remove" onPress={() => remove(item.id)} />} />
      ) : (
        <List data={items()} key={(i) => i.id} itemAnimation="move" style={{ flex: 1 }} row={(item) => <L2Row item={item} note="Move: tap to remove" onPress={() => remove(item.id)} />} />
      )}
    </Column>
  )
}

// ---- b) Reorder ----------------------------------------------------------------------------------------------------

function L2Reorder() {
  const items = signal<L2Item[]>(Array.from({ length: 24 }, (_, i) => ({ id: `p${i + 1}`, name: `Item ${i + 1}`, tint: TINTS[i % TINTS.length] })))
  const refuse = signal(false)
  const last = signal("Long press a row, drag it, drop it.")
  const longs = signal(0)
  const headerLongs = signal(0)
  let added = 24
  const addLater = () => {
    console.log("lists2 reorder: 3 rows come in 2 s")
    setTimeout(() => {
      const more = Array.from({ length: 3 }, () => {
        added++
        return { id: `p${added}`, name: `Item ${added} (added)`, tint: TINTS[added % TINTS.length] }
      })
      items.set([...items(), ...more])
      console.log(`lists2 reorder: added ${more.map((i) => i.id).join(",")} → ${items().length} rows`)
    }, 2000)
  }
  const move = (from: number, to: number) => {
    console.log(`lists2 reorder onReorder ${from} → ${to}${refuse() ? " (JS says no)" : ""}`)
    if (refuse()) {
      last.set(`JS said no to ${from + 1} → ${to + 1}: it goes back.`)
      return
    }
    const list = items().slice()
    const [hit] = list.splice(from, 1)
    if (!hit) return
    list.splice(to, 0, hit)
    items.set(list)
    last.set(`${hit.name} moved from ${from + 1} to ${to + 1}.`)
  }
  return (
    <Column style={{ flex: 1 }}>
      <Row style={{ gap: 6, paddingHorizontal: 16, paddingBottom: 6, alignItems: "center" }}>
        <L2Button label={refuse() ? "JS says no" : "JS moves it"} on={refuse()} onPress={() => refuse.set(!refuse())} />
        <L2Button label="Add 3 in 2 s" onPress={addLater} />
        <Text fontSize={11} color={longs() > 0 ? "#B91C1C" : c.muted} style={{ flex: 1 }}>
          {`onLongPress ran ${longs()} times (should stay 0)`}
        </Text>
      </Row>
      <Text fontSize={12} color={c.muted} style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
        {last()}
      </Text>
      <List
        data={items()}
        key={(i) => i.id}
        reorderable
        onReorder={move}
        style={{ flex: 1 }}
        ListHeaderComponent={
          <Pressable
            onLongPress={() => {
              headerLongs.set(headerLongs() + 1)
              console.log(`lists2 reorder header onLongPress ran (${headerLongs()})`)
            }}
            style={{ marginHorizontal: 16, marginBottom: 4, padding: 10, borderRadius: 10, backgroundColor: c.pillBg }}
          >
            <Text fontSize={12} color={c.ink}>
              {`Header: long press me (ran ${headerLongs()} times, should go up)`}
            </Text>
          </Pressable>
        }

        row={(item, i) => (
          <L2Row
            item={item}
            note={`Rank ${i + 1}`}
            onPress={() => console.log(`lists2 reorder tap ${item.id}`)}
            onLongPress={() => {
              longs.set(longs() + 1)
              console.log(`lists2 reorder onLongPress ran on ${item.id} (it should not)`)
            }}
          />
        )}
      />
    </Column>
  )
}

// ---- c) Scroll -----------------------------------------------------------------------------------------------------

const SNAP_ROWS: L2Item[] = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `Row ${i}`, tint: TINTS[i % TINTS.length] }))

function L2Scroll() {
  const ctrl = listController()
  const log = signal<string[]>([])
  const y = signal(0)
  const text = signal("")
  const add = (line: string) => {
    console.log(`lists2 scroll ${line}`)
    log.set([line, ...log()].slice(0, 4))
  }
  return (
    <Column style={{ flex: 1 }}>
      <Row style={{ gap: 6, paddingHorizontal: 16, paddingBottom: 6, flexWrap: "wrap" }}>
        <L2Button label="Index 10, viewOffset 40" onPress={() => { add("run: index 10 viewOffset 40"); ctrl.scrollToIndex({ index: 10, viewOffset: 40, animated: false }) }} />
        <L2Button label="Offset 300" onPress={() => { add("run: offset 300"); ctrl.scrollToOffset({ offset: 300 }) }} />
        <L2Button label="End" onPress={() => { add("run: end"); ctrl.scrollToEnd() }} />
        <L2Button label="Top" onPress={() => { add("run: top"); ctrl.scrollToOffset({ offset: 0, animated: false }) }} />
      </Row>
      <TextField
        value={text()}
        onChangeText={(t) => text.set(t)}
        placeholder="Type, then drag the list: the keyboard closes"
        onBlur={() => add("field blur")}
        style={{ marginHorizontal: 16, marginBottom: 6, height: 40, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.white }}
      />
      <Text fontSize={12} fontWeight={700} color={c.ink} style={{ paddingHorizontal: 16 }}>
        {`y = ${y()} (rows snap to 72 dp)`}
      </Text>
      <Column style={{ paddingHorizontal: 16, paddingVertical: 4, gap: 1 }}>
        {log().map((line, i) => (
          <Text key={String(i) + line} fontSize={11} color={i === 0 ? c.ink : c.muted}>
            {line}
          </Text>
        ))}
      </Column>
      <List
        data={SNAP_ROWS}
        key={(i) => i.id}
        controller={ctrl}
        snapToInterval={72}
        decelerationRate="fast"
        keyboardDismissMode="on-drag"
        scrollEventThrottle={100}
        onScroll={(e) => y.set(Math.round(e.nativeEvent.contentOffset.y))}
        onScrollBeginDrag={(e) => add(`begin drag at ${Math.round(e.nativeEvent.contentOffset.y)}`)}
        onScrollEndDrag={(e) => add(`end drag at ${Math.round(e.nativeEvent.contentOffset.y)}`)}
        onMomentumScrollBegin={(e) => add(`momentum begin, speed ${Math.round(e.nativeEvent.velocity?.y ?? 0)}`)}
        onMomentumScrollEnd={(e) => add(`momentum end at ${Math.round(e.nativeEvent.contentOffset.y)} (${Math.round(e.nativeEvent.contentOffset.y) % 72 === 0 ? "on a row" : "between rows"})`)}
        style={{ flex: 1 }}
        row={(item) => <L2Row item={item} note="72 dp tall with its margins" onPress={() => add(`tap ${item.id}`)} />}
      />
    </Column>
  )
}

// ---- d) Pinned + inverted ------------------------------------------------------------------------------------------

const PINNED: L2Item[] = Array.from({ length: 30 }, (_, i) =>
  i % 10 === 0
    ? { id: `h${i}`, name: `Section ${i / 10 + 1}`, tint: "#1E293B" }
    : { id: `q${i}`, name: `Entry ${i}`, tint: TINTS[i % TINTS.length] },
)

function L2Pinned() {
  const refreshing = signal(false)
  const y = signal(0)
  const messages = signal<string[]>(["Hello", "How are you?", "Fine, thanks", "See you"])
  return (
    <Column style={{ flex: 1, gap: 8 }}>
      <Text fontSize={12} fontWeight={700} color={c.ink} style={{ paddingHorizontal: 16 }}>
        {`y = ${y()}${refreshing() ? " (refreshing: stays 0 at rest)" : ""}`}
      </Text>
      <List
        data={PINNED}
        key={(i) => i.id}
        stickyHeaderIndices={[0, 10, 20]}
        refreshing={refreshing()}
        onRefresh={() => {
          console.log("lists2 pinned refresh")
          refreshing.set(true)
          setTimeout(() => refreshing.set(false), 3000)
        }}
        scrollEventThrottle={100}
        onScroll={(e) => y.set(Math.round(e.nativeEvent.contentOffset.y))}
        onMomentumScrollEnd={(e) => console.log(`lists2 pinned momentum end at ${Math.round(e.nativeEvent.contentOffset.y)}${refreshing() ? " (refreshing)" : ""}`)}
        style={{ flex: 1 }}
        row={(item) =>
          item.id.startsWith("h") ? (
            <Column style={{ height: 36, backgroundColor: item.tint, paddingHorizontal: 16, justifyContent: "center" }}>
              <Text fontSize={13} fontWeight={800} color={c.white}>
                {item.name}
              </Text>
            </Column>
          ) : (
            <Column style={{ height: 48, paddingHorizontal: 16, justifyContent: "center", backgroundColor: c.white }}>
              <Text fontSize={14} color={c.ink}>
                {item.name}
              </Text>
            </Column>
          )
        }
      />
      <Row style={{ gap: 6, paddingHorizontal: 16, alignItems: "center" }}>
        <Text fontSize={12} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          Inverted chat (newest at the bottom)
        </Text>
        <L2Button label="Send" onPress={() => messages.set([`Message ${messages().length + 1}`, ...messages()])} />
      </Row>
      <List
        data={messages()}
        key={(m) => m}
        inverted
        itemAnimation="fade"
        style={{ height: 180, flexGrow: 0, marginHorizontal: 16, marginBottom: 12, borderRadius: 12, backgroundColor: c.white }}
        row={(m) => (
          <Row style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
            <Text fontSize={14} color={c.ink} style={{ backgroundColor: c.pillBg, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 }}>
              {m}
            </Text>
          </Row>
        )}
      />
    </Column>
  )
}

// ---- e) More: sideways commands, inverted snapping -------------------------------------------------------------------

const SIDE: L2Item[] = Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, name: `Card ${i}`, tint: TINTS[i % TINTS.length] }))
const OLDER: L2Item[] = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, name: `Message ${i} (0 is newest)`, tint: TINTS[i % TINTS.length] }))

function L2More() {
  const side = listController()
  const log = signal<string[]>([])
  const add = (line: string) => {
    console.log(`lists2 more ${line}`)
    log.set([line, ...log()].slice(0, 3))
  }
  return (
    <Column style={{ flex: 1, gap: 6 }}>
      <Row style={{ gap: 6, paddingHorizontal: 16, flexWrap: "wrap" }}>
        <L2Button label="Side: offset 300" onPress={() => { add("side: offset 300"); side.scrollToOffset({ offset: 300, animated: false }) }} />
        <L2Button label="Side: index 5, viewOffset 20" onPress={() => { add("side: index 5 viewOffset 20"); side.scrollToIndex({ index: 5, viewOffset: 20, animated: false }) }} />
        <L2Button label="Side: start" onPress={() => { add("side: start"); side.scrollToOffset({ offset: 0, animated: false }) }} />
      </Row>
      <Text fontSize={11} color={c.muted} style={{ paddingHorizontal: 16 }}>
        {"Cards are 100 dp wide with 8 dp gaps: offset 300 shows Card 2 cut at its 84th dp, index 5 + 20 puts Card 5 at 20 dp."}
      </Text>
      <List
        data={SIDE}
        key={(i) => i.id}
        horizontal
        controller={side}
        gap={8}
        style={{ height: 80, flexGrow: 0 }}
        row={(item) => (
          <Column style={{ width: 100, height: 80, borderRadius: 12, backgroundColor: item.tint, justifyContent: "center", alignItems: "center" }}>
            <Text fontSize={14} fontWeight={700} color={c.ink}>
              {item.name}
            </Text>
          </Column>
        )}
      />
      <Column style={{ paddingHorizontal: 16, gap: 1 }}>
        {log().map((line, i) => (
          <Text key={String(i) + line} fontSize={11} color={i === 0 ? c.ink : c.muted}>
            {line}
          </Text>
        ))}
      </Column>
      <Text fontSize={12} fontWeight={700} color={c.ink} style={{ paddingHorizontal: 16 }}>
        Inverted, snaps to 60 dp rows: a fling down shows older ones (speed +)
      </Text>
      <List
        data={OLDER}
        key={(i) => i.id}
        inverted
        snapToInterval={60}
        onMomentumScrollBegin={(e) => add(`inverted momentum begin, speed ${Math.round(e.nativeEvent.velocity?.y ?? 0)}`)}
        onMomentumScrollEnd={(e) => add(`inverted momentum end at ${Math.round(e.nativeEvent.contentOffset.y)} (${Math.round(e.nativeEvent.contentOffset.y) % 60 === 0 ? "on a row" : "between rows"})`)}
        style={{ flex: 1, marginHorizontal: 16, marginBottom: 12, borderRadius: 12, backgroundColor: c.white }}
        row={(item) => (
          <Column style={{ height: 60, paddingHorizontal: 12, justifyContent: "center", backgroundColor: item.tint }}>
            <Text fontSize={14} color={c.ink}>
              {item.name}
            </Text>
          </Column>
        )}
      />
    </Column>
  )
}

// ---- The lab -------------------------------------------------------------------------------------------------------

export function ListsTwoLabScreen() {
  const tab = signal<"animate" | "reorder" | "scroll" | "pinned" | "more">("animate")
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={16} color={c.primary}>
            Back
          </Text>
        </Pressable>
        <Text fontSize={18} fontWeight={800} color={c.ink}>
          Lists 2
        </Text>
      </Row>
      <Row style={{ gap: 6, paddingHorizontal: 16, paddingBottom: 10 }}>
        <L2Button label="Animate" on={tab() === "animate"} onPress={() => tab.set("animate")} />
        <L2Button label="Reorder" on={tab() === "reorder"} onPress={() => tab.set("reorder")} />
        <L2Button label="Scroll" on={tab() === "scroll"} onPress={() => tab.set("scroll")} />
        <L2Button label="Pinned" on={tab() === "pinned"} onPress={() => tab.set("pinned")} />
        <L2Button label="More" on={tab() === "more"} onPress={() => tab.set("more")} />
      </Row>
      {tab() === "animate" ? <L2Animate /> : tab() === "reorder" ? <L2Reorder /> : tab() === "scroll" ? <L2Scroll /> : tab() === "pinned" ? <L2Pinned /> : <L2More />}
    </Column>
  )
}
