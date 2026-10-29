// exp4-flow/js/screens/TransactionDetailScreen.tsx - ZeroBill Production TxnInfoScreen (1:1 Parity with Flutter/RN)
import { h, Column, Row, Box, Text, Pressable, Spacer } from "../zn/h";
import { nav } from "../zn/nav";
import { signal } from "../zn/signals";
import { SafeAreaView } from "../zn/insets";
import { mod } from "../zn/modifier";

export interface TransactionDetailProps {
  _rootId?: number;
  tx: {
    id: number;
    merchant: string;
    category: string;
    time: string;
    amount: string;
    avatar: string;
    isCredit: boolean;
  };
  onBack?: () => void;
}

const RATING_WORDS: Record<number, string> = {
  1: "Terrible 😞",
  2: "Bad 🙁",
  3: "Average 😐",
  4: "Good 😊",
  5: "Awesome! 🌟",
};

export function TransactionDetailScreen(props: TransactionDetailProps) {
  const isCredit = props.tx?.isCredit ?? false;
  const rating = signal<number>(5);
  const isAccordionOpen = signal<boolean>(true);

  // Exact ZeroBill Flutter/RN Pastel Status Colors
  const statusColor = isCredit ? "#66c76b" : "#66c76b";
  const statusBg = isCredit ? "#DCFCE7" : "#E8F5E9";

  return (
    <Column
      _rootId={props._rootId}
      fill={true}
      bg="#F8FAFC"
      paddingHorizontal={16}
      paddingVertical={12}
      gap={12}
    >
        {/* 1. ZeroBill Material AppBar (56dp) */}
        <Row justify="space-between" align="center" width="100%" height={52}>
          <Row align="center" gap={12}>
            <Pressable
              onPress={() => nav.pop()}
              width={40}
              height={40}
              radius={20}
              bg="#FFFFFF"
              border={1}
              borderColor="#E2E8F0"
              align="center"
              justify="center"
              pressedScale={0.92}
            >
              <Text text="←" size={20} weight="bold" color="#0F172A" />
            </Pressable>
            <Column gap={2}>
              <Text
                text="Transaction Details"
                size={18}
                weight="bold"
                color="#0F172A"
              />
              <Text
                text="ZeroBill Verified Receipt"
                size={11}
                weight="medium"
                color="#64748B"
              />
            </Column>
          </Row>

          <Pressable
            width={40}
            height={40}
            radius={20}
            bg="#FFFFFF"
            border={1}
            borderColor="#E2E8F0"
            align="center"
            justify="center"
            pressedScale={0.92}
          >
            <Text text="↗" size={18} weight="bold" color="#0F172A" />
          </Pressable>
        </Row>

        {/* 2. ZeroBill Pastel Status & Amount Hero Card (Argon Chained Modifiers) */}
        <Box
          modifiers={mod
            .padding(16)
            .background(statusBg, 14)
            .border(1, "#C8E6C9", 14)}
          width="100%"
        >
          <Row justify="space-between" align="center" width="100%">
            <Row align="center" gap={12}>
              <Box
                width={48}
                height={48}
                radius={24}
                bg="#FFFFFF"
                align="center"
                justify="center"
              >
                <Text
                  text={props.tx?.avatar || "Z"}
                  size={22}
                  weight="bold"
                  color="#2E7D32"
                />
              </Box>
              <Column gap={2}>
                <Row align="center" gap={4}>
                  <Text
                    text={props.tx?.merchant || "Merchant Store"}
                    size={16}
                    weight="bold"
                    color="#1B5E20"
                  />
                  <Text text="✓" size={13} weight="bold" color="#2E7D32" />
                </Row>
                <Text
                  text="Payment Successful"
                  size={12}
                  weight="bold"
                  color="#2E7D32"
                />
              </Column>
            </Row>

            <Column align="flex-end">
              <Text
                text={props.tx?.amount || "₹0.00"}
                size={22}
                weight="bold"
                color="#1B5E20"
              />
              <Text text="Instant UPI" size={11} color="#4CAF50" />
            </Column>
          </Row>
        </Box>

        {/* 3. Bill Breakdown Accordion (Parity with ZeroBill RN ZCard) */}
        <Box
          modifiers={mod
            .padding(14)
            .background("#FFFFFF", 12)
            .border(1, "#E2E8F0", 12)}
          width="100%"
        >
          <Column width="100%" gap={10}>
            <Row justify="space-between" align="center" width="100%">
              <Row align="center" gap={8}>
                <Text text="🛍️" size={16} />
                <Text
                  text="Bill Amount Breakdown"
                  size={14}
                  weight="bold"
                  color="#0F172A"
                />
              </Row>
              <Text text="4 Items" size={12} weight="bold" color="#64748B" />
            </Row>

            <Box height={1} bg="#F1F5F9" width="100%" />

            {/* Item 1 */}
            <Row justify="space-between" width="100%">
              <Text text="Total Items (Subtotal)" size={13} color="#64748B" />
              <Text text="₹450.00" size={13} weight="medium" color="#0F172A" />
            </Row>

            {/* Discount */}
            <Row justify="space-between" width="100%">
              <Row align="center" gap={4}>
                <Text text="🏷️ ZeroBill Cashback Savings" size={13} color="#16A34A" />
              </Row>
              <Text text="-₹30.00" size={13} weight="bold" color="#16A34A" />
            </Row>

            {/* Taxes */}
            <Row justify="space-between" width="100%">
              <Text text="CGST + SGST (5%)" size={13} color="#64748B" />
              <Text text="₹0.00" size={13} weight="medium" color="#0F172A" />
            </Row>

            <Box height={1} bg="#F1F5F9" width="100%" />

            {/* Net Paid */}
            <Row justify="space-between" align="center" width="100%">
              <Text text="Net Paid Amount" size={14} weight="bold" color="#0F172A" />
              <Text
                text={props.tx?.amount || "₹420.00"}
                size={16}
                weight="bold"
                color="#0F172A"
              />
            </Row>
          </Column>
        </Box>

        {/* 4. Payment Metadata & Bank UTR Card */}
        <Box
          modifiers={mod
            .padding(14)
            .background("#FFFFFF", 12)
            .border(1, "#E2E8F0", 12)}
          width="100%"
        >
          <Column width="100%" gap={8}>
            <Row justify="space-between" width="100%">
              <Text text="UPI Reference ID (UTR)" size={12} color="#64748B" />
              <Text
                text="UPI/429103829102/CR"
                size={12}
                weight="bold"
                color="#0F172A"
              />
            </Row>
            <Row justify="space-between" width="100%">
              <Text text="Payment Mode" size={12} color="#64748B" />
              <Text
                text="Google Pay • HDFC Bank •• 4892"
                size={12}
                weight="medium"
                color="#0F172A"
              />
            </Row>
            <Row justify="space-between" width="100%">
              <Text text="Date & Time" size={12} color="#64748B" />
              <Text
                text={props.tx?.time || "Oct 28, 2026 • 5:52 PM"}
                size={12}
                weight="medium"
                color="#0F172A"
              />
            </Row>
          </Column>
        </Box>

        {/* 5. ZeroBill Experience Rating Card (Interactive Parity) */}
        <Box
          modifiers={mod
            .padding(14)
            .background("#FFFFFF", 12)
            .border(1, "#E2E8F0", 12)}
          width="100%"
        >
          <Column align="center" width="100%" gap={8}>
            <Text
              text="How was your billing experience?"
              size={13}
              weight="bold"
              color="#0F172A"
            />
            <Row justify="center" gap={12}>
              {[1, 2, 3, 4, 5].map((star) => (
                <Pressable
                  key={star}
                  onPress={() => rating.set(star)}
                  padding={6}
                  pressedScale={0.88}
                >
                  <Text
                    text={star <= rating() ? "★" : "☆"}
                    size={28}
                    weight="bold"
                    color={star <= rating() ? "#F59E0B" : "#CBD5E1"}
                  />
                </Pressable>
              ))}
            </Row>
            <Text
              text={() => RATING_WORDS[rating()] || "Awesome!"}
              size={12}
              weight="bold"
              color="#F59E0B"
            />
          </Column>
        </Box>

        {/* 6. Sticky Bottom Action CTAs */}
        <Row width="100%" gap={10} marginTop={4}>
          <Pressable
            weight={1}
            height={48}
            radius={12}
            bg="#0F172A"
            align="center"
            justify="center"
            pressedScale={0.96}
            haptic="medium"
          >
            <Text text="📄 Digital Receipt" size={14} weight="bold" color="#FFFFFF" />
          </Pressable>

          <Pressable
            weight={1}
            height={48}
            radius={12}
            bg="#FFFFFF"
            border={1}
            borderColor="#E2E8F0"
            align="center"
            justify="center"
            pressedScale={0.96}
            haptic="light"
          >
            <Text text="🔁 Repeat Pay" size={14} weight="bold" color="#0F172A" />
          </Pressable>
        </Row>
      </Column>
  );
}
