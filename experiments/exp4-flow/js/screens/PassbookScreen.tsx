/**
 * ZeroBill Passbook Screen (Dish A: 100% TSX-Compiled Virtual List)
 * Every single transaction card is a pure TSX component composed of Row, Box, Text, and Column!
 */

import { h, LazyColumn, Column, Row, Box, Text, Pressable, Spacer } from "../zn/h";
import { Colors } from "../zn/tokens";
import { nav } from "../zn/nav";

interface Transaction {
  id: number;
  merchant: string;
  category: string;
  time: string;
  amount: string;
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

function generateTransactions(count: number): Transaction[] {
  const items: Transaction[] = [];
  for (let i = 1; i <= count; i++) {
    const template = MERCHANTS[(i - 1) % MERCHANTS.length];
    items.push({
      id: i,
      merchant: `${template.name} #${i}`,
      category: template.cat,
      time: `Oct ${28 - ((i / 350) | 0)}, 2026 • ${((i * 7) % 12) + 1}:${(i * 13) % 60 < 10 ? "0" : ""}${(i * 13) % 60} ${i % 2 === 0 ? "PM" : "AM"}`,
      amount: template.cr ? `+${template.amt}` : `-${template.amt}`,
      isCredit: template.cr,
    });
  }
  return items;
}

// 100 realistic transactions = 1,100 real ZnNodes instantiated in TSX!
const TRANSACTIONS = generateTransactions(100);

export function PassbookScreen(props: { _rootId?: number; onBack?: () => void }) {
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
            <Text text="100% Pure TSX Components" size={12} color={Colors.textMuted} />
          </Column>
        </Row>

        <Box bg="#DCFCE7" radius={12} paddingHorizontal={10} paddingVertical={4}>
          <Text text={`⚡ ${TRANSACTIONS.length} TSX CARDS`} size={11} weight="bold" color="#16A34A" />
        </Box>
      </Row>

      {/* 2. 100% Pure TSX LazyColumn - Every single card is a real ZnNode */}
      <LazyColumn fill gap={8}>
        {TRANSACTIONS.map((tx) => (
          <TransactionCard key={tx.id} tx={tx} />
        ))}
      </LazyColumn>
    </Column>
  );
}

// Subcomponent: 100% Pure TSX Transaction Card
function TransactionCard(props: { tx: Transaction }) {
  const { tx } = props;
  return (
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
    >
      <Row align="center" gap={12}>
        <Box
          width={42}
          height={42}
          radius={21}
          bg={tx.isCredit ? "#DCFCE7" : "#F1F5F9"}
          align="center"
          justify="center"
        >
          <Text
            text={tx.isCredit ? "₹" : tx.merchant.slice(0, 1)}
            size={18}
            weight="bold"
            color={tx.isCredit ? "#16A34A" : "#0F172A"}
          />
        </Box>
        <Column gap={2}>
          <Text text={tx.merchant} size={15} weight="bold" color="#0F172A" />
          <Text text={tx.time} size={12} color="#64748B" />
        </Column>
      </Row>

      <Column align="flex-end" gap={2}>
        <Text
          text={tx.amount}
          size={15}
          weight="bold"
          color={tx.isCredit ? "#16A34A" : "#0F172A"}
        />
        <Text text={tx.category} size={11} color="#64748B" />
      </Column>
    </Row>
  );
}
