/**
 * ZeroBill Passbook Screen (Dish A / Frontier 2: Templated Slot VirtualList)
 * 10,000 items rendered via 100% declarative TSX template with ZERO hardcoded Kotlin cards!
 */

import { h, VirtualList, Column, Row, Box, Text, Pressable, Spacer } from "../zn/h";
import { signal, computed } from "../zn/signals";
import { Colors } from "../zn/tokens";
import { nav } from "../zn/nav";
import { SafeAreaView } from "../zn/insets";

interface Transaction {
  id: number;
  merchant: string;
  category: string;
  time: string;
  amount: string;
  avatar: string;
  isCredit: boolean;
}

const MERCHANTS = [
  { name: "Swiggy", cat: "Food & Dining", amt: "₹340.00", cr: false },
  { name: "ZeroBill Cashback", cat: "Rewards", amt: "₹50.00", cr: true },
  { name: "Starbucks Coffee", cat: "Beverages", amt: "₹420.00", cr: false },
  { name: "Zepto 10-Min", cat: "Groceries", amt: "₹289.00", cr: false },
  { name: "Uber India", cat: "Travel", amt: "₹195.00", cr: false },
  { name: "Flipkart Internet", cat: "Shopping", amt: "₹1,249.00", cr: false },
  { name: "Kalyan Jewellers", cat: "Jewellery", amt: "₹5,400.00", cr: false },
  { name: "Zomato Limited", cat: "Dining", amt: "₹612.00", cr: false },
  { name: "Google Play Store", cat: "Subscriptions", amt: "₹179.00", cr: false },
  { name: "Apollo Pharmacy", cat: "Healthcare", amt: "₹450.00", cr: false },
];

function generate10000Transactions(): Transaction[] {
  const items: Transaction[] = [];
  for (let i = 1; i <= 10000; i++) {
    const template = MERCHANTS[(i - 1) % MERCHANTS.length];
    items.push({
      id: i,
      merchant: `${template.name} #${i}`,
      category: template.cat,
      time: `Oct ${28 - ((i / 350) | 0)}, 2026 • ${((i * 7) % 12) + 1}:${(i * 13) % 60 < 10 ? "0" : ""}${(i * 13) % 60} ${i % 2 === 0 ? "PM" : "AM"}`,
      amount: template.cr ? `+${template.amt}` : `-${template.amt}`,
      avatar: template.cr ? "₹" : template.name.slice(0, 1),
      isCredit: template.cr,
    });
  }
  return items;
}

const ALL_TRANSACTIONS = generate10000Transactions();

export function PassbookScreen(props: { _rootId?: number; onBack?: () => void }) {
  const windowStart = signal(0);
  const WINDOW_SIZE = 80;

  // Signal-driven window: only 80 items in native memory at any time!
  const windowData = computed(() => {
    const start = windowStart();
    return ALL_TRANSACTIONS.slice(start, start + WINDOW_SIZE);
  });

  const onScrollWindow = (firstVisiblePayload: any) => {
    const firstVisible = typeof firstVisiblePayload === "number" ? firstVisiblePayload : parseInt(String(firstVisiblePayload), 10) || 0;
    const targetStart = Math.max(0, Math.min(ALL_TRANSACTIONS.length - WINDOW_SIZE, firstVisible - 20));
    if (firstVisible === 0) {
      windowStart.set(0);
    } else if (Math.abs(targetStart - windowStart()) >= 6) {
      windowStart.set(targetStart);
    }
  };

  return (
    <Column _rootId={props._rootId} fill bg={Colors.background} paddingHorizontal={16} paddingTop={16}>
      {/* 1. Header with Back Button */}
      <Row height={52} align="center" justify="space-between" marginBottom={12}>
        <Row align="center">
          <Pressable
            width={40}
            height={40}
            radius={20}
            bg={Colors.surface}
            align="center"
            justify="center"
            pressedScale={0.92}
            onPress={() => nav.pop()}
          >
            <Text text="←" size={20} weight="bold" color={Colors.textPrimary} />
          </Pressable>
          <Spacer width={12} />
          <Column>
            <Text text="Passbook" size={20} weight="bold" color={Colors.textPrimary} />
            <Text text="10,000 Items (100% TSX Template)" size={12} color={Colors.textMuted} />
          </Column>
        </Row>

        <Box bg="#DCFCE7" radius={12} paddingHorizontal={10} paddingVertical={4}>
          <Text text="⚡ 10K TEMPLATED" size={11} weight="bold" color="#16A34A" />
        </Box>
      </Row>

      {/* 2. Zero-Native Templated Slot VirtualList (100% TSX Template declared once!) */}
      <VirtualList
        fill
        gap={8}
        totalCount={ALL_TRANSACTIONS.length}
        windowStart={() => windowStart()}
        data={() => windowData()}
        onScrollWindow={onScrollWindow}
        template={(slot: any) => (
          <Row
            height={72}
            radius={12}
            bg="#FFFFFF"
            border={1}
            borderColor="#E2E8F0"
            paddingHorizontal={14}
            paddingVertical={10}
            align="center"
            justify="space-between"
            width="100%"
            onPress={(payload: any) => {
              const id = typeof payload === "object" ? payload?.id : Number(payload);
              const item = ALL_TRANSACTIONS.find((t) => t.id === id);
              if (item) {
                nav.push("/transaction-detail", { tx: item });
              }
            }}
          >
            <Row align="center" gap={12}>
              <Box
                width={42}
                height={42}
                radius={21}
                bg={slot.cond("isCredit", "#DCFCE7", "#F1F5F9")}
                align="center"
                justify="center"
              >
                <Text
                  text={slot("avatar")}
                  size={18}
                  weight="bold"
                  color={slot.cond("isCredit", "#16A34A", "#0F172A")}
                />
              </Box>
              <Column gap={2}>
                <Text text={slot("merchant")} size={15} weight="bold" color="#0F172A" />
                <Text text={slot("time")} size={12} color="#64748B" />
              </Column>
            </Row>

            <Column align="flex-end" gap={2}>
              <Text
                text={slot("amount")}
                size={15}
                weight="bold"
                color={slot.cond("isCredit", "#16A34A", "#0F172A")}
              />
              <Text text={slot("category")} size={11} color="#64748B" />
            </Column>
          </Row>
        )}
      />
    </Column>
  );
}
