/**
 * ZeroBill Amount Screen (1:1 Native Parity)
 * Driven by Hermes V1 + Reactive Signals.
 */

import { h, Fragment, Column, Row, Box, Text, Pressable, Spacer, Image } from "../zn/h";
import { signal, computed } from "../zn/signals";
import { Colors } from "../zn/tokens";
import { nav } from "../zn/nav";
import { SafeAreaView } from "../zn/insets";
import {
  formatIndianDisplay,
  parseToPaise,
  calculateFinancials,
  applyKeypadInput,
  applyBackspace,
  SessionData,
} from "../zn/money";

export interface AmountScreenProps {
  session?: SessionData;
  onPayNow?: (amountPaise: number) => void;
  onBack?: () => void;
}

export function AmountScreen(props: AmountScreenProps) {
  const session: SessionData = props.session || {
    max_cashback: 50,
    min_total_to_use_cashback: 200,
    platform_fee: 5,
    merchant: {
      name: "⚡ ZeroBill SuperStore (Fast1!)",
      counters: 2,
    },
  };

  // Reactive State
  const [amountStr, setAmountStr] = signal("0");
  const [cursorVisible, setCursorVisible] = signal(true);

  // Blinking cursor timer (500 ms)
  setInterval(() => {
    setCursorVisible((v) => !v);
  }, 500);

  // Computed Derivations
  const amountPaise = computed(() => parseToPaise(amountStr()));
  const amountRupees = computed(() => amountPaise() / 100);
  const displayAmount = computed(() => formatIndianDisplay(amountStr()));
  const financials = computed(() => calculateFinancials(amountRupees(), session));
  const hasCashback = computed(() => financials().cashback > 0);
  const isPayActive = computed(() => amountPaise() > 0);

  // Rapid backspace timer
  let backspaceTimer: any = null;

  const onKeyTap = (key: string) => {
    setAmountStr((prev) => applyKeypadInput(prev, key));
  };

  const onBackspaceTap = () => {
    setAmountStr((prev) => {
      if (prev === "0" || prev === "") return "0";
      return applyBackspace(prev);
    });
  };

  const onBackspaceStart = () => {
    onBackspaceTap();
    if (backspaceTimer) {
      clearInterval(backspaceTimer);
      backspaceTimer = null;
    }
    backspaceTimer = setInterval(() => {
      onBackspaceTap();
    }, 150);
  };

  const onBackspaceEnd = () => {
    if (backspaceTimer) {
      clearInterval(backspaceTimer);
      backspaceTimer = null;
    }
  };

  return (
    <Column fill={true} bg={Colors.surface}>
      {/* 1. Merchant Header */}
      <Row
        width="100%"
        padding={16}
        justify="space-between"
        align="center"
        borderBottom={1}
        borderColor={Colors.border}
      >
        <Pressable onPress={props.onBack} padding={8} pressedScale={0.92} haptic="light">
          <Text text="←" size={24} weight="bold" color={Colors.textPrimary} />
        </Pressable>

        <Column align="center" weight={1}>
          <Text
            text={session.merchant?.name || "Merchant"}
            size={18}
            weight="extrabold"
            color={Colors.textPrimary}
          />
          <Text text="Counter 1 • Multi-Counter" size={12} weight="medium" color={Colors.textSecondary} />
        </Column>

        <Row align="center">
          <Pressable
            paddingHorizontal={10}
            paddingVertical={6}
            radius={8}
            bg="#F1F5F9"
            pressedScale={0.94}
            onPress={() => nav.push("/passbook")}
          >
            <Text text="📜 Passbook" size={12} weight="bold" color={Colors.textPrimary} />
          </Pressable>
          <Spacer width={8} />
          <Pressable padding={8} pressedScale={0.92} haptic="light">
            <Text text="%" size={20} weight="bold" color={Colors.primary} />
          </Pressable>
        </Row>
      </Row>

      {/* 2. Amount Display */}
      <Column weight={1} align="center" justify="center" padding={20} width="100%">
        <Row align="center" justify="center">
          <Text text="₹" size={36} weight="medium" color={Colors.textDisabled} />
          <Spacer width={10} />
          <Text
            text={() => displayAmount()}
            size={56}
            weight="bold"
            color={() => (amountStr() === "0" ? Colors.textDisabled : Colors.textPrimary)}
            autoShrink={true}
          />
          {/* Blinking Cursor */}
          <Box
            width={3}
            height={48}
            bg={Colors.primaryHover}
            radius={1.5}
            opacity={() => (cursorVisible() ? 1 : 0)}
          />
        </Row>

        {/* Dynamic Cashback Badge */}
        <Box
          opacity={() => (hasCashback() ? 1 : 0)}
          bg={Colors.successLight}
          paddingHorizontal={14}
          paddingVertical={6}
          radius={20}
          marginTop={16}
        >
          <Text
            text={() => `🎉 ₹${financials().cashback} Cashback applied!`}
            size={13}
            weight="bold"
            color={Colors.successText}
          />
        </Box>
      </Column>

      {/* 3. Custom 3x4 Keypad */}
      <Column width="100%" bg={Colors.keypadBg} padding={12} gap={8}>
        {/* Row 1 */}
        <Row width="100%" gap={8}>
          <KeypadButton label="1" onPress={() => onKeyTap("1")} />
          <KeypadButton label="2" onPress={() => onKeyTap("2")} />
          <KeypadButton label="3" onPress={() => onKeyTap("3")} />
        </Row>
        {/* Row 2 */}
        <Row width="100%" gap={8}>
          <KeypadButton label="4" onPress={() => onKeyTap("4")} />
          <KeypadButton label="5" onPress={() => onKeyTap("5")} />
          <KeypadButton label="6" onPress={() => onKeyTap("6")} />
        </Row>
        {/* Row 3 */}
        <Row width="100%" gap={8}>
          <KeypadButton label="7" onPress={() => onKeyTap("7")} />
          <KeypadButton label="8" onPress={() => onKeyTap("8")} />
          <KeypadButton label="9" onPress={() => onKeyTap("9")} />
        </Row>
        {/* Row 4 */}
        <Row width="100%" gap={8}>
          <KeypadButton label="." onPress={() => onKeyTap(".")} />
          <KeypadButton label="0" onPress={() => onKeyTap("0")} />
          <KeypadButton
            label="⌫"
            onTouchDown={onBackspaceStart}
            onTouchUp={onBackspaceEnd}
          />
        </Row>

        {/* 4. Pay CTA Button */}
        <Pressable
          width="100%"
          height={56}
          radius={14}
          align="center"
          justify="center"
          bg={() => (isPayActive() ? Colors.primary : Colors.background)}
          disabled={() => !isPayActive()}
          pressedScale={0.98}
          haptic="medium"
          onPress={() => {
            if (isPayActive()) {
              props.onPayNow?.(amountPaise());
              nav.push("/checkout", {
                amountPaise: amountPaise(),
                amountFormatted: displayAmount(),
                cashbackPaise: Math.round(financials().cashback * 100),
                feePaise: Math.round(financials().fee * 100),
                toPayPaise: Math.round(financials().toPay * 100),
                merchantName: session.merchant?.name || "Kalyan Jewellers",
                counterName: "Counter 1",
              });
            }
          }}
          marginTop={8}
        >
          <Text
            text={() => (isPayActive() ? `Pay Now (₹${financials().toPay}) →` : "⚡ TAP A DIGIT TO BEGIN")}
            size={16}
            weight="bold"
            color={() => (isPayActive() ? "#FFFFFF" : Colors.textMuted)}
          />
        </Pressable>
      </Column>
    </Column>
  );
}

function KeypadButton(props: {
  label: string;
  onPress?: () => void;
  onTouchDown?: () => void;
  onTouchUp?: () => void;
}) {
  return (
    <Pressable
      weight={1}
      height={64}
      radius={12}
      bg={Colors.surface}
      border={1}
      borderColor={Colors.border}
      align="center"
      justify="center"
      pressedScale={0.94}
      haptic="light"
      onPress={props.onPress}
      onTouchDown={props.onTouchDown}
      onTouchUp={props.onTouchUp}
    >
      <Text text={props.label} size={26} weight="bold" color={Colors.keypadText} />
    </Pressable>
  );
}
