// zn/runtime.ts
var nextNodeId = 1;
function allocateNodeId() {
  return nextNodeId++;
}
var currentBatch = [];
var isFlushScheduled = false;
function queueOp(op) {
  currentBatch.push(op);
  if (!isFlushScheduled) {
    isFlushScheduled = true;
    Promise.resolve().then(flushBatch);
  }
}
function flushBatch() {
  if (currentBatch.length === 0) {
    isFlushScheduled = false;
    return;
  }
  const ops = currentBatch;
  currentBatch = [];
  isFlushScheduled = false;
  if (typeof __zn_flush === "function") {
    __zn_flush(JSON.stringify(ops));
  } else {
    console.log("[zn mock flush]", JSON.stringify(ops));
  }
}
var eventHandlers = new Map;
function registerEventHandler(nodeId, eventName, handler) {
  if (typeof __zn_log === "function") {
    __zn_log(1, `[EVENT_REG] ${nodeId}:${eventName} -> typeof: ${typeof handler}, val: ${String(handler).slice(0, 40)}`);
  }
  eventHandlers.set(`${nodeId}:${eventName}`, handler);
}
globalThis.__zn_event = function(nodeId, eventName, payloadJson) {
  const key = `${nodeId}:${eventName}`;
  const handler = eventHandlers.get(key);
  if (typeof __zn_log === "function") {
    __zn_log(1, `[EVENT_DISP] key: ${key}, handler typeof: ${typeof handler}`);
  }
  if (typeof handler === "function") {
    try {
      const payload = payloadJson ? JSON.parse(payloadJson) : undefined;
      handler(payload);
    } catch (e) {
      console.error(`Error in event handler ${key}`, e);
    }
  } else {
    console.error(`Handler for ${key} is not a function (typeof: ${typeof handler})`);
  }
};
var nextTimerId = 1;
var activeTimers = new Map;
globalThis.__zn_timerFired = function(id) {
  const cb = activeTimers.get(id);
  if (cb) {
    activeTimers.delete(id);
    try {
      cb();
    } catch (e) {
      console.error("Error in timer callback", e);
    }
  }
};
function setTimeoutPolyfill(fn, delayMs) {
  const id = nextTimerId++;
  activeTimers.set(id, fn);
  if (typeof __zn_setTimeout === "function") {
    __zn_setTimeout(id, delayMs);
  } else {
    setTimeout(fn, delayMs);
  }
  return id;
}
function clearTimeoutPolyfill(id) {
  activeTimers.delete(id);
  if (typeof __zn_clearTimeout === "function") {
    __zn_clearTimeout(id);
  } else {
    clearTimeout(id);
  }
}
function setIntervalPolyfill(fn, intervalMs) {
  let timerId = 0;
  function tick() {
    fn();
    timerId = setTimeoutPolyfill(tick, intervalMs);
  }
  timerId = setTimeoutPolyfill(tick, intervalMs);
  return timerId;
}
function clearIntervalPolyfill(id) {
  clearTimeoutPolyfill(id);
}
if (typeof setTimeout === "undefined" || typeof __zn_setTimeout === "function") {
  globalThis.setTimeout = setTimeoutPolyfill;
  globalThis.clearTimeout = clearTimeoutPolyfill;
  globalThis.setInterval = setIntervalPolyfill;
  globalThis.clearInterval = clearIntervalPolyfill;
}
globalThis.console = {
  log: (...args) => {
    if (typeof __zn_log === "function")
      __zn_log(1, args.map(String).join(" "));
  },
  warn: (...args) => {
    if (typeof __zn_log === "function")
      __zn_log(2, args.map(String).join(" "));
  },
  error: (...args) => {
    if (typeof __zn_log === "function")
      __zn_log(3, args.map(String).join(" "));
  }
};

// zn/signals.ts
var activeSubscriber = null;
var isUntracking = false;
var batchDepth = 0;
var pendingEffects = new Set;
function signal(initialValue) {
  let value = initialValue;
  const subscribers = new Set;
  const get = () => {
    if (activeSubscriber && !isUntracking) {
      subscribers.add(activeSubscriber);
      activeSubscriber.dependencies.add(subscribers);
    }
    return value;
  };
  const set = (next) => {
    const nextVal = typeof next === "function" ? next(value) : next;
    if (!Object.is(value, nextVal)) {
      value = nextVal;
      for (const sub of Array.from(subscribers)) {
        if (batchDepth > 0) {
          pendingEffects.add(sub);
        } else {
          try {
            sub.run();
          } catch (e) {
            console.error("[SUB_ERROR]", e?.message, e?.stack);
          }
        }
      }
    }
  };
  return [get, set];
}
function computed(fn) {
  let cachedValue;
  let isDirty = true;
  const subscribers = new Set;
  const computation = {
    dependencies: new Set,
    run() {
      if (!isDirty) {
        isDirty = true;
        for (const sub of Array.from(subscribers)) {
          if (batchDepth > 0) {
            pendingEffects.add(sub);
          } else {
            try {
              sub.run();
            } catch (e) {
              console.error("[COMP_SUB_ERROR]", e?.message, e?.stack);
            }
          }
        }
      }
    }
  };
  return () => {
    if (activeSubscriber && !isUntracking) {
      subscribers.add(activeSubscriber);
      activeSubscriber.dependencies.add(subscribers);
    }
    if (isDirty) {
      cleanupDependencies(computation);
      const prev = activeSubscriber;
      activeSubscriber = computation;
      try {
        cachedValue = fn();
        isDirty = false;
      } catch (e) {
        console.error("[COMPUTED_FN_ERROR]", e?.message, e?.stack);
        throw e;
      } finally {
        activeSubscriber = prev;
      }
    }
    return cachedValue;
  };
}
function effect(fn) {
  let cleanup;
  let isDisposed = false;
  const computation = {
    dependencies: new Set,
    run() {
      if (isDisposed)
        return;
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (e) {
          console.error("Error in effect cleanup", e?.message, e?.stack);
        }
        cleanup = undefined;
      }
      cleanupDependencies(computation);
      const prev = activeSubscriber;
      activeSubscriber = computation;
      try {
        const res = fn();
        cleanup = typeof res === "function" ? res : undefined;
      } catch (e) {
        console.error("[EFFECT_FN_ERROR]", e?.message, e?.stack);
        throw e;
      } finally {
        activeSubscriber = prev;
      }
    }
  };
  computation.run();
  return () => {
    isDisposed = true;
    if (typeof cleanup === "function") {
      cleanup();
      cleanup = undefined;
    }
    cleanupDependencies(computation);
  };
}
function cleanupDependencies(comp) {
  for (const depSet of comp.dependencies) {
    depSet.delete(comp);
  }
  comp.dependencies.clear();
}

// zn/h.ts
var Column = "Column";
var Row = "Row";
var Box = "Box";
var Text = "Text";
var Pressable = "Pressable";
var Spacer = "Spacer";
function bindReactiveProp(nodeId, propKey, getter) {
  effect(() => {
    const evaluated = getter();
    queueOp(["p", nodeId, propKey, evaluated]);
  });
}
function bindReactiveChild(textNodeId, getter) {
  effect(() => {
    const val = getter();
    queueOp(["p", textNodeId, "text", String(val ?? "")]);
  });
}
function h(type, props, ...rawChildren) {
  if (typeof type === "function") {
    return type(props || {}, ...rawChildren);
  }
  const nodeId = allocateNodeId();
  queueOp(["c", nodeId, type]);
  const children = rawChildren.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === "children")
        continue;
      if (key.startsWith("on") && typeof value === "function") {
        registerEventHandler(nodeId, key, value);
        queueOp(["p", nodeId, key, true]);
      } else if (typeof value === "function") {
        bindReactiveProp(nodeId, key, value);
      } else {
        queueOp(["p", nodeId, key, value]);
      }
    }
  }
  let childIdx = 0;
  for (const child of children) {
    if (typeof child === "number") {
      queueOp(["i", nodeId, child, childIdx++]);
    } else if (typeof child === "string" || typeof child === "number") {
      const textId = allocateNodeId();
      queueOp(["c", textId, "Text"]);
      queueOp(["p", textId, "text", String(child)]);
      queueOp(["i", nodeId, textId, childIdx++]);
    } else if (typeof child === "function") {
      const textId = allocateNodeId();
      queueOp(["c", textId, "Text"]);
      bindReactiveChild(textId, child);
      queueOp(["i", nodeId, textId, childIdx++]);
    }
  }
  return nodeId;
}

// zn/tokens.ts
var Colors = {
  primary: "#3D26ED",
  primaryHover: "#341DEC",
  primaryLight: "#EEF2FF",
  surface: "#FFFFFF",
  background: "#F8FAFC",
  textPrimary: "#1C1C1C",
  textSecondary: "#64748B",
  textMuted: "#94A3B8",
  textDisabled: "#BDBDBD",
  border: "#E2E8F0",
  success: "#10B981",
  successLight: "#ECFDF5",
  successText: "#047857",
  keypadBg: "#F8FAFC",
  keypadText: "#0F172A",
  keypadPressed: "#E2E8F0"
};

// zn/money.ts
function formatIndianDisplay(raw) {
  if (!raw || raw === "0")
    return "0";
  const parts = raw.split(".");
  const intStr = parts[0] || "0";
  let lastThree = intStr.substring(intStr.length - 3);
  const otherNumbers = intStr.substring(0, intStr.length - 3);
  if (otherNumbers !== "") {
    lastThree = "," + lastThree;
  }
  const formattedInt = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree;
  if (parts.length > 1) {
    return `${formattedInt}.${parts[1]}`;
  }
  return formattedInt;
}
function parseToPaise(raw) {
  if (!raw || raw === "0")
    return 0;
  const parts = raw.split(".");
  const rupees = parseInt(parts[0], 10) || 0;
  let paise = 0;
  if (parts.length > 1) {
    const decStr = (parts[1] + "00").substring(0, 2);
    paise = parseInt(decStr, 10) || 0;
  }
  return rupees * 100 + paise;
}
function calculateFinancials(amountRupees, session) {
  if (!session) {
    return { cashback: 0, fee: 0, toPay: amountRupees };
  }
  const maxCashback = session.max_cashback || 0;
  const minTotal = session.min_total_to_use_cashback || 0;
  const platformFee = session.platform_fee || 0;
  let cashback = 0;
  if (maxCashback > 0 && amountRupees > maxCashback && amountRupees >= minTotal) {
    cashback = maxCashback;
  }
  const fee = cashback > 0 && platformFee > 0 ? platformFee : 0;
  const toPay = Math.max(0, amountRupees - cashback + fee);
  return { cashback, fee, toPay };
}
function applyKeypadInput(currentStr, key) {
  if (key === ".") {
    if (currentStr.includes("."))
      return currentStr;
    if (currentStr === "0" || currentStr === "")
      return "0.";
    return currentStr + ".";
  }
  if (currentStr.includes(".")) {
    const parts = currentStr.split(".");
    if (parts[1] && parts[1].length >= 2)
      return currentStr;
  } else {
    if (currentStr.length >= 7)
      return currentStr;
  }
  if (currentStr === "0") {
    return key;
  }
  return currentStr + key;
}
function applyBackspace(currentStr) {
  if (currentStr.length <= 1) {
    return "0";
  }
  return currentStr.slice(0, -1);
}

// screens/AmountScreen.tsx
function AmountScreen(props) {
  const session = props.session || {
    max_cashback: 50,
    min_total_to_use_cashback: 200,
    platform_fee: 5,
    merchant: {
      name: "Kalyan Jewellers",
      counters: 2
    }
  };
  const [amountStr, setAmountStr] = signal("0");
  const [cursorVisible, setCursorVisible] = signal(true);
  setInterval(() => {
    setCursorVisible((v) => !v);
  }, 500);
  const amountPaise = computed(() => parseToPaise(amountStr()));
  const amountRupees = computed(() => amountPaise() / 100);
  const displayAmount = computed(() => formatIndianDisplay(amountStr()));
  const financials = computed(() => calculateFinancials(amountRupees(), session));
  const hasCashback = computed(() => financials().cashback > 0);
  const isPayActive = computed(() => amountPaise() > 0);
  let backspaceTimer = null;
  const onKeyTap = (key) => {
    setAmountStr((prev) => applyKeypadInput(prev, key));
  };
  const onBackspaceTap = () => {
    setAmountStr((prev) => applyBackspace(prev));
  };
  const onBackspaceStart = () => {
    onBackspaceTap();
    if (backspaceTimer)
      clearInterval(backspaceTimer);
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
  return /* @__PURE__ */ h(Column, {
    fill: true,
    bg: Colors.surface
  }, /* @__PURE__ */ h(Row, {
    width: "100%",
    padding: 16,
    justify: "space-between",
    align: "center",
    borderBottom: 1,
    borderColor: Colors.border
  }, /* @__PURE__ */ h(Pressable, {
    onPress: props.onBack,
    padding: 8,
    pressedScale: 0.92,
    haptic: "light"
  }, /* @__PURE__ */ h(Text, {
    text: "←",
    size: 24,
    weight: "bold",
    color: Colors.textPrimary
  })), /* @__PURE__ */ h(Column, {
    align: "center",
    weight: 1
  }, /* @__PURE__ */ h(Text, {
    text: session.merchant?.name || "Merchant",
    size: 18,
    weight: "extrabold",
    color: Colors.textPrimary
  }), /* @__PURE__ */ h(Text, {
    text: "Counter 1 • Multi-Counter",
    size: 12,
    weight: "medium",
    color: Colors.textSecondary
  })), /* @__PURE__ */ h(Pressable, {
    padding: 8,
    pressedScale: 0.92,
    haptic: "light"
  }, /* @__PURE__ */ h(Text, {
    text: "%",
    size: 20,
    weight: "bold",
    color: Colors.primary
  }))), /* @__PURE__ */ h(Column, {
    weight: 1,
    align: "center",
    justify: "center",
    padding: 20,
    width: "100%"
  }, /* @__PURE__ */ h(Row, {
    align: "center",
    justify: "center"
  }, /* @__PURE__ */ h(Text, {
    text: "₹",
    size: 36,
    weight: "medium",
    color: Colors.textDisabled
  }), /* @__PURE__ */ h(Spacer, {
    width: 10
  }), /* @__PURE__ */ h(Text, {
    text: () => displayAmount(),
    size: 56,
    weight: "bold",
    color: () => amountStr() === "0" ? Colors.textDisabled : Colors.textPrimary,
    autoShrink: true
  }), /* @__PURE__ */ h(Box, {
    width: 3,
    height: 48,
    bg: Colors.primaryHover,
    radius: 1.5,
    opacity: () => cursorVisible() ? 1 : 0
  })), /* @__PURE__ */ h(Box, {
    opacity: () => hasCashback() ? 1 : 0,
    bg: Colors.successLight,
    paddingHorizontal: 14,
    paddingVertical: 6,
    radius: 20,
    marginTop: 16
  }, /* @__PURE__ */ h(Text, {
    text: () => `\uD83C\uDF89 ₹${financials().cashback} Cashback applied!`,
    size: 13,
    weight: "bold",
    color: Colors.successText
  }))), /* @__PURE__ */ h(Column, {
    width: "100%",
    bg: Colors.keypadBg,
    padding: 12,
    gap: 8
  }, /* @__PURE__ */ h(Row, {
    width: "100%",
    gap: 8
  }, /* @__PURE__ */ h(KeypadButton, {
    label: "1",
    onPress: () => onKeyTap("1")
  }), /* @__PURE__ */ h(KeypadButton, {
    label: "2",
    onPress: () => onKeyTap("2")
  }), /* @__PURE__ */ h(KeypadButton, {
    label: "3",
    onPress: () => onKeyTap("3")
  })), /* @__PURE__ */ h(Row, {
    width: "100%",
    gap: 8
  }, /* @__PURE__ */ h(KeypadButton, {
    label: "4",
    onPress: () => onKeyTap("4")
  }), /* @__PURE__ */ h(KeypadButton, {
    label: "5",
    onPress: () => onKeyTap("5")
  }), /* @__PURE__ */ h(KeypadButton, {
    label: "6",
    onPress: () => onKeyTap("6")
  })), /* @__PURE__ */ h(Row, {
    width: "100%",
    gap: 8
  }, /* @__PURE__ */ h(KeypadButton, {
    label: "7",
    onPress: () => onKeyTap("7")
  }), /* @__PURE__ */ h(KeypadButton, {
    label: "8",
    onPress: () => onKeyTap("8")
  }), /* @__PURE__ */ h(KeypadButton, {
    label: "9",
    onPress: () => onKeyTap("9")
  })), /* @__PURE__ */ h(Row, {
    width: "100%",
    gap: 8
  }, /* @__PURE__ */ h(KeypadButton, {
    label: ".",
    onPress: () => onKeyTap(".")
  }), /* @__PURE__ */ h(KeypadButton, {
    label: "0",
    onPress: () => onKeyTap("0")
  }), /* @__PURE__ */ h(KeypadButton, {
    label: "⌫",
    onPress: onBackspaceTap,
    onTouchDown: onBackspaceStart,
    onTouchUp: onBackspaceEnd
  })), /* @__PURE__ */ h(Pressable, {
    width: "100%",
    height: 56,
    radius: 14,
    align: "center",
    justify: "center",
    bg: () => isPayActive() ? Colors.primary : Colors.background,
    disabled: () => !isPayActive(),
    pressedScale: 0.98,
    haptic: "medium",
    onPress: () => {
      if (isPayActive()) {
        props.onPayNow?.(amountPaise());
      }
    },
    marginTop: 8
  }, /* @__PURE__ */ h(Text, {
    text: () => isPayActive() ? `Pay Now (₹${financials().toPay}) →` : "Enter Amount",
    size: 16,
    weight: "bold",
    color: () => isPayActive() ? "#FFFFFF" : Colors.textMuted
  }))));
}
function KeypadButton(props) {
  return /* @__PURE__ */ h(Pressable, {
    weight: 1,
    height: 64,
    radius: 12,
    bg: Colors.surface,
    border: 1,
    borderColor: Colors.border,
    align: "center",
    justify: "center",
    pressedScale: 0.94,
    haptic: "light",
    onPress: props.onPress,
    onTouchDown: props.onTouchDown,
    onTouchUp: props.onTouchUp
  }, /* @__PURE__ */ h(Text, {
    text: props.label,
    size: 26,
    weight: "bold",
    color: Colors.keypadText
  }));
}

// main.tsx
queueOp(["c", 0, "Box"]);
queueOp(["p", 0, "fill", true]);
var screenId = AmountScreen({
  onPayNow: (paise) => {
    console.log("[JS] Pay Now pressed with amount:", paise / 100);
  },
  onBack: () => {
    console.log("[JS] Back pressed");
  }
});
queueOp(["i", 0, screenId, 0]);
flushBatch();
