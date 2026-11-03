// Tabs lab (route /dev/tabs, guide notes §40): a home screen like ZeroBill's. Four tabs, each with its own data from
// the local test server, and the app's own tab bar with a centre Scan button. Phone steps: tools/plugin-phone/tabs.ts.
//
//   bun run tools/fetch-test-server.ts
//   adb reverse tcp:8788 tcp:8788
//   adb shell am start -a android.intent.action.VIEW -d "zn://sample/dev/tabs" dev.zeronative.sample
//
// Link options (query values become props): ?preload=1 builds all four tabs at once; ?fetch=shown loads a tab's data
// only when the tab is first shown (default: all four loads start with the screen). /dev/tabs/<tab> opens that tab.
// Log lines "tabs-lab ..." (logcat tag zn-js) are read by the phone steps and tools/measure-tabs.ts.
//
// Pull to refresh (guide notes §41) on every tab: Pay and Rewards use the flat props (refreshing, onRefresh), Stores
// (a List) and Offers (a Scroll) use React Native's refreshControl={<RefreshControl />}, as ZeroBill's tabs do.
import { Box, Column, Icon, List, Pressable, RefreshControl, Row, Scroll, Stack, Tabs, Text, TextField } from "@zero-native/ui"
import { Keyboard, nav, signal, useTabs, type Signal, type TabsHandle } from "@zero-native/core"
import { c } from "./tokens"
import { gift, qrScan, receipt, shoppingBag, tag } from "./icons"

type Tab = "pay" | "stores" | "offers" | "rewards"
type Item = { id: string; title: string; subtitle: string; amount: number }
type Data = { items: Signal<Item[] | null>; error: Signal<string>; refreshing: Signal<boolean>; refreshes: Signal<number> }

const SERVER = "http://localhost:8788"
/** Each tab's server delay (ms): like real home tabs, they answer at different times. */
const DELAY: Record<Tab, number> = { pay: 250, stores: 400, offers: 600, rewards: 300 }
/** A pull's server delay: long enough to see the spinner. */
const REFRESH_MS = 1200

const say = (text: string) => console.info(`tabs-lab ${text}`)

async function load(tab: Tab, d: Data, ms = DELAY[tab]): Promise<void> {
  try {
    const res = await fetch(`${SERVER}/tabs/${tab}?ms=${ms}&rows=40`)
    const body = (await res.json()) as { items: Item[] }
    d.items.set(body.items)
    d.error.set("")
    say(`data ${tab} ${body.items.length}`)
  } catch (e) {
    d.error.set("Couldn't load. Is tools/fetch-test-server.ts running (with adb reverse)?")
    say(`data ${tab} failed: ${String(e)}`)
  }
}

/** onRefresh: the RN way. `refreshing` is true while the data loads, and the spinner follows it. */
async function refresh(tab: Tab, d: Data): Promise<void> {
  if (d.refreshing()) return
  d.refreshing.set(true)
  say(`refresh ${tab} start`)
  await load(tab, d, REFRESH_MS)
  d.refreshes.set((n) => n + 1)
  d.refreshing.set(false)
  say(`refresh ${tab} done ${d.refreshes()}`)
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`

function ItemRow(props: { item: Item; onPress?: () => void }) {
  return (
    <Pressable onPress={() => props.onPress?.()} style={{ paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.white }}>
      <Row style={{ alignItems: "center", gap: 12 }}>
        <Column style={{ flex: 1 }}>
          <Text fontSize={15} fontWeight={600} color={c.ink}>
            {props.item.title}
          </Text>
          <Text fontSize={12} color={c.muted}>
            {props.item.subtitle}
          </Text>
        </Column>
        <Text fontSize={15} fontWeight={700} color={c.ink}>
          {rupees(props.item.amount)}
        </Text>
      </Row>
    </Pressable>
  )
}

function Status(props: { d: Data }) {
  return (
    <>
      {props.d.items() === null && props.d.error() === "" && (
        <Text fontSize={14} color={c.muted} style={{ padding: 16 }}>
          Loading…
        </Text>
      )}
      {props.d.error() !== "" && (
        <Text fontSize={14} color="#B91C1C" style={{ padding: 16 }}>
          {props.d.error()}
        </Text>
      )}
      {props.d.refreshes() > 0 && (
        <Text fontSize={12} color={c.muted} style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
          {`Refreshed ${props.d.refreshes()}×`}
        </Text>
      )}
    </>
  )
}

// Pay: rows open the amount screen (a screen pushed over the tabs), and its data reloads each time it gets focus
// again (back from paying), like ZeroBill's cashback balance.
function PayTab(props: { tabs: TabsHandle<Tab>; d: Data; fetchOnShow: boolean }) {
  say("built pay")
  if (props.fetchOnShow) void load("pay", props.d)
  let focusCount = 0
  props.tabs.onFocus("pay", () => {
    focusCount++
    say(`focus pay ${focusCount}`)
    if (focusCount > 1) {
      say("reload pay")
      void load("pay", props.d)
    }
  })
  return (
    <Scroll style={{ flex: 1 }} refreshing={props.d.refreshing()} onRefresh={() => void refresh("pay", props.d)} refreshColor={c.primary}>
      <Column style={{ gap: 1, paddingBottom: 24 }}>
        <Row style={{ gap: 8, padding: 16 }}>
          <Pressable
            onPress={() => nav.reset([{ name: "tabsLab" }])}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.pillBg }}
          >
            <Text fontSize={13} fontWeight={600} color={c.ink}>
              Only screen
            </Text>
          </Pressable>
          <Pressable
            onPress={() => props.tabs.select("rewards")}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.pillBg }}
          >
            <Text fontSize={13} fontWeight={600} color={c.ink}>
              See rewards
            </Text>
          </Pressable>
        </Row>
        <Status d={props.d} />
        {(props.d.items() ?? []).map((item) => (
          <ItemRow key={item.id} item={item} onPress={() => nav.push("amount", { merchantId: "m1" })} />
        ))}
      </Column>
    </Scroll>
  )
}

// Stores: a virtualized <List> (its scroll position must survive a tab switch) and a search field (the bar hides while
// the keyboard is open).
function StoresTab(props: { tabs: TabsHandle<Tab>; d: Data; fetchOnShow: boolean }) {
  say("built stores")
  if (props.fetchOnShow) void load("stores", props.d)
  props.tabs.onFocus("stores", () => say("focus stores"))
  const query = signal("")
  return (
    <Column style={{ flex: 1 }}>
      <TextField
        value={query()}
        onChangeText={(t) => query.set(t)}
        placeholder="Search stores"
        style={{ margin: 12, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
      />
      <Status d={props.d} />
      <List
        data={(props.d.items() ?? []).filter((i) => i.title.toLowerCase().includes(query().toLowerCase()))}
        key={(i) => i.id}
        style={{ flex: 1 }}
        gap={1}
        row={(i) => <ItemRow item={i} />}
        refreshControl={
          <RefreshControl refreshing={props.d.refreshing()} onRefresh={() => void refresh("stores", props.d)} colors={[c.primary]} tintColor={c.primary} />
        }
      />
    </Column>
  )
}

function OffersTab(props: { tabs: TabsHandle<Tab>; d: Data; fetchOnShow: boolean }) {
  say("built offers")
  if (props.fetchOnShow) void load("offers", props.d)
  props.tabs.onFocus("offers", () => say("focus offers"))
  return (
    <Scroll
      style={{ flex: 1 }}
      refreshControl={<RefreshControl refreshing={props.d.refreshing()} onRefresh={() => void refresh("offers", props.d)} colors={[c.primary]} />}
    >
      <Column style={{ gap: 1, paddingBottom: 24 }}>
        <Status d={props.d} />
        {(props.d.items() ?? []).map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </Column>
    </Scroll>
  )
}

// Rewards: a tap counter: its value must still be there after a tab switch (the tab's JS state is kept).
function RewardsTab(props: { tabs: TabsHandle<Tab>; d: Data; fetchOnShow: boolean }) {
  say("built rewards")
  if (props.fetchOnShow) void load("rewards", props.d)
  props.tabs.onFocus("rewards", () => say("focus rewards"))
  const taps = signal(0)
  return (
    <Scroll
      style={{ flex: 1 }}
      refreshing={props.d.refreshing()}
      onRefresh={() => void refresh("rewards", props.d)}
      refreshColor={c.white}
      refreshBackground={c.primary}
    >
      <Column style={{ gap: 12, padding: 16 }}>
        <Pressable
          onPress={() => {
            taps.set((n) => n + 1)
            say(`taps ${taps()}`)
          }}
          style={{ padding: 16, borderRadius: 14, backgroundColor: c.primary, alignItems: "center" }}
        >
          <Text fontSize={15} fontWeight={700} color={c.white}>
            {`Taps: ${taps()}`}
          </Text>
        </Pressable>
        <Status d={props.d} />
        {(props.d.items() ?? []).slice(0, 12).map((item) => (
          <ItemRow key={item.id} item={item} onPress={() => nav.push("amount", { merchantId: "m1" })} />
        ))}
      </Column>
    </Scroll>
  )
}

function BarItem(props: { label: string; active: boolean; badge: string; onPress: () => void; children?: unknown }) {
  return (
    <Pressable
      onPress={() => props.onPress()}
      pressFeedback="none"
      pressScale={0.92}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      style={{ flex: 1, alignItems: "center", paddingVertical: 6, gap: 3 }}
    >
      {/* Wider than the icon: an absolute child is measured inside its Stack, and the badge sticks out to the right. */}
      <Stack style={{ width: 72, height: 24, alignItems: "center", justifyContent: "center" }}>
        {props.children}
        {props.badge !== "" && (
          <Box style={{ position: "absolute", top: -5, start: 34, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8, backgroundColor: "#B91B1B", alignItems: "center", justifyContent: "center" }}>
            <Text fontSize={10} fontWeight={700} color={c.white}>
              {props.badge}
            </Text>
          </Box>
        )}
      </Stack>
      <Text fontSize={11} fontWeight={600} color={props.active ? c.primary : c.muted}>
        {props.label}
      </Text>
    </Pressable>
  )
}

/** The app's own tab bar: badges from the loaded data, a centre Scan button that stands up out of the bar. */
function TabBar(props: { tabs: TabsHandle<Tab>; data: Record<Tab, Data> }) {
  const color = (t: Tab) => (props.tabs.selected() === t ? c.primary : c.muted)
  const count = (t: Tab) => {
    const n = props.data[t].items()?.length ?? 0
    return n > 0 ? String(n) : ""
  }
  const earned = () => {
    const sum = (props.data.rewards.items() ?? []).reduce((s, i) => s + i.amount, 0)
    return sum > 0 ? `₹${(sum / 1000).toFixed(1)}k+` : ""
  }
  const scan = async () => {
    say("scan open")
    const value = await nav.pushForResult<string>("scan")
    say(`scan answer ${value}`)
  }
  return (
    <Row style={{ height: 58, alignItems: "center", backgroundColor: c.white, borderTopWidth: 1, borderColor: c.border, paddingHorizontal: 8 }}>
      <BarItem label="ZeroBill" active={props.tabs.selected() === "pay"} badge="" onPress={() => props.tabs.select("pay")}>
        <Icon icon={receipt} color={color("pay")} style={{ width: 24, height: 24 }} />
      </BarItem>
      <BarItem label="Stores" active={props.tabs.selected() === "stores"} badge={count("stores")} onPress={() => props.tabs.select("stores")}>
        <Icon icon={shoppingBag} color={color("stores")} style={{ width: 24, height: 24 }} />
      </BarItem>
      {/* The bar stays 58 dp. The label sits where the other tabs' labels sit (an empty 24 dp box stands in for the
          icon), and the button is placed over it, standing 25 dp above the bar's top line as in ZeroBill. */}
      <Stack style={{ flex: 1, height: 58, alignItems: "center", justifyContent: "center" }}>
        {/* The label opens the scanner too: a bigger target than the button alone. */}
        <Pressable onPress={() => void scan()} pressFeedback="none" accessibilityRole="none" style={{ alignItems: "center", paddingVertical: 6, gap: 3 }}>
          <Box style={{ width: 24, height: 24 }} />
          <Text fontSize={11} fontWeight={600} color={c.muted}>
            Scan
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void scan()}
          accessibilityLabel="Scan"
          rippleColor={c.white}
          style={{ position: "absolute", top: -25, width: 56, height: 56, borderRadius: 14, backgroundColor: c.primary, alignItems: "center", justifyContent: "center", elevation: 2 }}
        >
          <Icon icon={qrScan} color={c.white} style={{ width: 28, height: 28 }} />
        </Pressable>
      </Stack>
      <BarItem label="Offers" active={props.tabs.selected() === "offers"} badge={count("offers")} onPress={() => props.tabs.select("offers")}>
        <Icon icon={tag} color={color("offers")} style={{ width: 24, height: 24 }} />
      </BarItem>
      <BarItem label="Rewards" active={props.tabs.selected() === "rewards"} badge={earned()} onPress={() => props.tabs.select("rewards")}>
        <Icon icon={gift} color={color("rewards")} style={{ width: 24, height: 24 }} />
      </BarItem>
    </Row>
  )
}

export function TabsLabScreen(props: { tab?: string; preload?: string; fetch?: string }) {
  const tabs = useTabs("tabsLab", { preload: props.preload === "1" })
  const fetchOnShow = props.fetch === "shown"
  const data: Record<Tab, Data> = {
    pay: { items: signal<Item[] | null>(null), error: signal(""), refreshing: signal(false), refreshes: signal(0) },
    stores: { items: signal<Item[] | null>(null), error: signal(""), refreshing: signal(false), refreshes: signal(0) },
    offers: { items: signal<Item[] | null>(null), error: signal(""), refreshing: signal(false), refreshes: signal(0) },
    rewards: { items: signal<Item[] | null>(null), error: signal(""), refreshing: signal(false), refreshes: signal(0) },
  }
  say(`screen tab=${tabs.selected()} preload=${props.preload === "1"} fetch=${fetchOnShow ? "shown" : "all"}`)
  // Like ZeroBill's home store: all four loads start with the screen, whatever tab is shown.
  if (!fetchOnShow) for (const t of tabs.names) void load(t, data[t])

  // The bar hides while the keyboard is open (the stores search), as in ZeroBill. Listeners stop with the screen.
  const keyboard = signal(Keyboard.isVisible())
  Keyboard.addListener("keyboardDidShow", () => keyboard.set(true))
  Keyboard.addListener("keyboardDidHide", () => keyboard.set(false))

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.white }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={18} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          Tabs lab
        </Text>
        <Text fontSize={12} color={c.muted}>
          {`tab: ${tabs.selected()}`}
        </Text>
      </Row>
      <Tabs selected={tabs.index()} style={{ flex: 1 }}>
        <Column style={{ flex: 1 }}>{tabs.seen("pay") && <PayTab tabs={tabs} d={data.pay} fetchOnShow={fetchOnShow} />}</Column>
        <Column style={{ flex: 1 }}>{tabs.seen("stores") && <StoresTab tabs={tabs} d={data.stores} fetchOnShow={fetchOnShow} />}</Column>
        <Column style={{ flex: 1 }}>{tabs.seen("offers") && <OffersTab tabs={tabs} d={data.offers} fetchOnShow={fetchOnShow} />}</Column>
        <Column style={{ flex: 1 }}>{tabs.seen("rewards") && <RewardsTab tabs={tabs} d={data.rewards} fetchOnShow={fetchOnShow} />}</Column>
      </Tabs>
      {!keyboard() && <TabBar tabs={tabs} data={data} />}
    </Column>
  )
}
