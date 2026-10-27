// zn/runtime.ts
var nextNodeId = 1;
function allocateNodeId() {
  return nextNodeId++;
}
var currentBatch = [];
var isFlushScheduled = false;
function scheduleFlush() {
  if (!isFlushScheduled) {
    isFlushScheduled = true;
    Promise.resolve().then(flushBatch);
  }
}
function queueOp(op) {
  currentBatch.push(op);
  scheduleFlush();
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
  get.set = set;
  get[0] = get;
  get[1] = set;
  get[Symbol.iterator] = function* () {
    yield get;
    yield set;
  };
  return get;
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

// zn/nav.ts
var backStack = signal([
  { route: "/amount", params: {}, entryId: 0 }
]);
var nav = {
  push(route, params = {}) {
    const entryId = allocateNodeId();
    const newEntry = { route, params, entryId };
    backStack.set([...backStack(), newEntry]);
    queueOp(["nav", "push", route, params, entryId]);
    scheduleFlush();
    return entryId;
  },
  pop() {
    const current = backStack();
    if (current.length > 1) {
      const popped = current[current.length - 1];
      backStack.set(current.slice(0, -1));
      queueOp(["nav", "pop", popped.route, popped.entryId]);
      scheduleFlush();
    }
  },
  replace(route, params = {}) {
    const current = backStack();
    const entryId = allocateNodeId();
    const newEntry = { route, params, entryId };
    backStack.set([...current.slice(0, -1), newEntry]);
    queueOp(["nav", "replace", route, params, entryId]);
    scheduleFlush();
    return entryId;
  }
};
registerEventHandler(0, "hardwareBack", () => {
  const current = backStack();
  if (current.length > 1) {
    backStack.set(current.slice(0, -1));
  }
});

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
  const nodeId = props && typeof props._rootId === "number" ? props._rootId : allocateNodeId();
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
        nav.push("/checkout", {
          amountPaise: amountPaise(),
          amountFormatted: displayAmount(),
          cashbackPaise: Math.round(financials().cashback * 100),
          feePaise: Math.round(financials().fee * 100),
          toPayPaise: Math.round(financials().toPay * 100),
          merchantName: session.merchant?.name || "Kalyan Jewellers",
          counterName: "Counter 1"
        });
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

// screens/CheckoutScreen.tsx
function CheckoutScreen(props) {
  const selectedApp = signal(null);
  const selectedAppName = signal("");
  const isLaunching = signal(false);
  const isSlowLaunch = signal(false);
  const jsProgress = signal(0);
  const startJsGlide = () => {
    jsProgress.set(0);
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      let p = 0;
      if (elapsed <= 400) {
        p = elapsed / 400 * 0.6;
      } else if (elapsed <= 1000) {
        p = 0.6 + (elapsed - 400) / 600 * 0.22;
      } else if (elapsed <= 2400) {
        p = 0.82 + (elapsed - 1000) / 1400 * 0.12;
      } else {
        p = 0.94;
        clearInterval(interval);
      }
      jsProgress.set(Math.min(0.94, p));
    }, 16);
    setTimeout(() => {
      if (isLaunching()) {
        isSlowLaunch.set(true);
      }
    }, 2400);
  };
  const onSelectUpiApp = (pkg, name) => {
    if (isLaunching())
      return;
    selectedApp.set(pkg);
    selectedAppName.set(name);
    isLaunching.set(true);
    startJsGlide();
    setTimeout(() => {
      if (typeof globalThis.__zn_launchUpi === "function") {
        globalThis.__zn_launchUpi(pkg, name, props.toPayPaise);
      }
    }, 800);
  };
  const toPayFormatted = computed(() => {
    const rupees = Math.floor(props.toPayPaise / 100);
    return `₹${rupees}`;
  });
  const cashbackFormatted = computed(() => {
    const rupees = Math.floor(props.cashbackPaise / 100);
    return `₹${rupees}`;
  });
  return /* @__PURE__ */ h(Column, {
    _rootId: props._rootId,
    fill: true,
    bg: "#F8FAFC"
  }, /* @__PURE__ */ h(Box, {
    fill: true,
    bg: "#FFFFFF",
    align: "center",
    justify: "center",
    visible: () => isSlowLaunch()
  }, /* @__PURE__ */ h(Column, {
    align: "center",
    gap: 16
  }, /* @__PURE__ */ h(Box, {
    width: 100,
    height: 100,
    radius: 24,
    bg: "#EEF2F6",
    align: "center",
    justify: "center",
    border: 1,
    borderColor: "#E2E8F0"
  }, /* @__PURE__ */ h(Text, {
    text: () => selectedAppName().slice(0, 2).toUpperCase(),
    size: 32,
    weight: "bold",
    color: "#3D26ED"
  })), /* @__PURE__ */ h(Text, {
    text: () => `Opening ${selectedAppName()}...`,
    size: 18,
    weight: "bold",
    color: "#0F172A"
  }), /* @__PURE__ */ h(Text, {
    text: "Please approve the payment in your UPI app",
    size: 14,
    color: "#64748B"
  }))), /* @__PURE__ */ h(Column, {
    fill: true,
    padding: 20,
    gap: 20,
    visible: () => !isSlowLaunch()
  }, /* @__PURE__ */ h(Row, {
    align: "center",
    gap: 12,
    width: "100%"
  }, /* @__PURE__ */ h(Pressable, {
    onPress: () => nav.pop(),
    width: 40,
    height: 40,
    radius: 20,
    bg: "#FFFFFF",
    border: 1,
    borderColor: "#E2E8F0",
    align: "center",
    justify: "center"
  }, /* @__PURE__ */ h(Text, {
    text: "←",
    size: 20,
    weight: "bold",
    color: "#0F172A"
  })), /* @__PURE__ */ h(Column, null, /* @__PURE__ */ h(Text, {
    text: "Select Payment Method",
    size: 18,
    weight: "bold",
    color: "#0F172A"
  }), /* @__PURE__ */ h(Text, {
    text: props.merchantName,
    size: 13,
    color: "#64748B"
  }))), /* @__PURE__ */ h(Column, {
    bg: "#FFFFFF",
    radius: 16,
    padding: 16,
    gap: 10,
    border: 1,
    borderColor: "#E2E8F0"
  }, /* @__PURE__ */ h(Row, {
    justify: "space-between",
    align: "center"
  }, /* @__PURE__ */ h(Text, {
    text: "Bill Amount",
    size: 14,
    color: "#64748B"
  }), /* @__PURE__ */ h(Text, {
    text: `₹${props.amountFormatted}`,
    size: 15,
    weight: "medium",
    color: "#0F172A"
  })), /* @__PURE__ */ h(Row, {
    justify: "space-between",
    align: "center"
  }, /* @__PURE__ */ h(Text, {
    text: "\uD83C\uDF89 ZeroBill Cashback",
    size: 14,
    color: "#059669"
  }), /* @__PURE__ */ h(Text, {
    text: () => `-${cashbackFormatted()}`,
    size: 15,
    weight: "bold",
    color: "#059669"
  })), /* @__PURE__ */ h(Box, {
    height: 1,
    bg: "#F1F5F9",
    width: "100%"
  }), /* @__PURE__ */ h(Row, {
    justify: "space-between",
    align: "center"
  }, /* @__PURE__ */ h(Text, {
    text: "Total to Pay",
    size: 16,
    weight: "bold",
    color: "#0F172A"
  }), /* @__PURE__ */ h(Text, {
    text: () => toPayFormatted(),
    size: 20,
    weight: "bold",
    color: "#3D26ED"
  }))), /* @__PURE__ */ h(Column, {
    gap: 4,
    marginTop: 8
  }, /* @__PURE__ */ h(Text, {
    text: "Pay via Installed UPI App",
    size: 15,
    weight: "bold",
    color: "#0F172A"
  }), /* @__PURE__ */ h(Text, {
    text: "Tap an app to pay instantly",
    size: 13,
    color: "#64748B"
  })), /* @__PURE__ */ h(Column, {
    gap: 12,
    width: "100%"
  }, /* @__PURE__ */ h(UpiTile, {
    name: "PhonePe",
    pkg: "com.phonepe.app",
    badge: "Instant",
    isSelected: () => selectedApp() === "com.phonepe.app",
    isLaunching: () => isLaunching() && selectedApp() === "com.phonepe.app",
    jsProgress,
    onSelect: () => onSelectUpiApp("com.phonepe.app", "PhonePe")
  }), /* @__PURE__ */ h(UpiTile, {
    name: "Paytm",
    pkg: "net.one97.paytm",
    badge: "Fast",
    isSelected: () => selectedApp() === "net.one97.paytm",
    isLaunching: () => isLaunching() && selectedApp() === "net.one97.paytm",
    jsProgress,
    onSelect: () => onSelectUpiApp("net.one97.paytm", "Paytm")
  }), /* @__PURE__ */ h(UpiTile, {
    name: "P2P Mock UPI (Safe Test)",
    pkg: "p2pdops.android.p2pupiapp",
    badge: "Test App",
    isSelected: () => selectedApp() === "p2pdops.android.p2pupiapp",
    isLaunching: () => isLaunching() && selectedApp() === "p2pdops.android.p2pupiapp",
    jsProgress,
    onSelect: () => onSelectUpiApp("p2pdops.android.p2pupiapp", "P2P Mock UPI")
  }), /* @__PURE__ */ h(UpiTile, {
    name: "CRED",
    pkg: "com.dreamplug.androidapp",
    badge: "Rewards",
    isSelected: () => selectedApp() === "com.dreamplug.androidapp",
    isLaunching: () => isLaunching() && selectedApp() === "com.dreamplug.androidapp",
    jsProgress,
    onSelect: () => onSelectUpiApp("com.dreamplug.androidapp", "CRED")
  }))));
}
function UpiTile(props) {
  return /* @__PURE__ */ h(Pressable, {
    onPress: props.onSelect,
    width: "100%",
    radius: 16,
    bg: "#FFFFFF",
    border: 1,
    borderColor: () => props.isSelected() ? "#3D26ED" : "#E2E8F0",
    padding: 16
  }, /* @__PURE__ */ h(Column, {
    width: "100%",
    gap: 10
  }, /* @__PURE__ */ h(Row, {
    justify: "space-between",
    align: "center",
    width: "100%"
  }, /* @__PURE__ */ h(Row, {
    align: "center",
    gap: 12
  }, /* @__PURE__ */ h(Box, {
    width: 44,
    height: 44,
    radius: 22,
    bg: "#F1F5F9",
    align: "center",
    justify: "center"
  }, /* @__PURE__ */ h(Text, {
    text: props.name.slice(0, 1),
    size: 18,
    weight: "bold",
    color: "#3D26ED"
  })), /* @__PURE__ */ h(Column, null, /* @__PURE__ */ h(Text, {
    text: props.name,
    size: 15,
    weight: "bold",
    color: "#0F172A"
  }), /* @__PURE__ */ h(Text, {
    text: props.pkg,
    size: 11,
    color: "#94A3B8"
  }))), props.badge && /* @__PURE__ */ h(Box, {
    bg: "#EEF2FF",
    paddingHorizontal: 8,
    paddingVertical: 4,
    radius: 6
  }, /* @__PURE__ */ h(Text, {
    text: props.badge,
    size: 11,
    weight: "medium",
    color: "#4338CA"
  }))), /* @__PURE__ */ h(Column, {
    width: "100%",
    gap: 6,
    visible: () => props.isLaunching()
  }, /* @__PURE__ */ h(Column, {
    gap: 2
  }, /* @__PURE__ */ h(Row, {
    justify: "space-between"
  }, /* @__PURE__ */ h(Text, {
    text: "Native Compose Animatable (60 FPS during onPause)",
    size: 10,
    color: "#059669"
  }), /* @__PURE__ */ h(Text, {
    text: "Native",
    size: 10,
    weight: "bold",
    color: "#059669"
  })), /* @__PURE__ */ h(Box, {
    width: "100%",
    height: 6,
    radius: 3,
    bg: "#E2E8F0"
  }, /* @__PURE__ */ h(UpiNativeBar, {
    isRunning: props.isLaunching
  }))), /* @__PURE__ */ h(Column, {
    gap: 2
  }, /* @__PURE__ */ h(Row, {
    justify: "space-between"
  }, /* @__PURE__ */ h(Text, {
    text: "JS Thread Glide (setTimeout 16ms op batch)",
    size: 10,
    color: "#2563EB"
  }), /* @__PURE__ */ h(Text, {
    text: () => `${Math.round(props.jsProgress() * 100)}%`,
    size: 10,
    weight: "bold",
    color: "#2563EB"
  })), /* @__PURE__ */ h(Box, {
    width: "100%",
    height: 6,
    radius: 3,
    bg: "#E2E8F0"
  }, /* @__PURE__ */ h(UpiJsBar, {
    progress: props.jsProgress
  }))))));
}
function UpiNativeBar(props) {
  return /* @__PURE__ */ h(Box, {
    height: 6,
    radius: 3,
    bg: "#059669",
    isNativeActive: props.isRunning
  });
}
function UpiJsBar(props) {
  return /* @__PURE__ */ h(Box, {
    height: 6,
    radius: 3,
    bg: "#2563EB",
    width: () => `${Math.round(props.progress() * 100)}%`
  });
}

// main.tsx
queueOp(["c", 0, "Box"]);
queueOp(["p", 0, "fill", true]);
var amountRootId = AmountScreen({
  _rootId: 1,
  onBack: () => {
    console.log("[JS] Root back pressed");
  }
});
queueOp(["i", 0, amountRootId, 0]);
var mountedEntryIds = new Set([0, 1]);
effect(() => {
  const stack = backStack();
  const top = stack[stack.length - 1];
  if (!top)
    return;
  if (!mountedEntryIds.has(top.entryId)) {
    mountedEntryIds.add(top.entryId);
    console.log(`[ROUTER] Mounting screen ${top.route} with entryId ${top.entryId}`);
    if (top.route === "/checkout") {
      CheckoutScreen({
        _rootId: top.entryId,
        amountPaise: top.params.amountPaise ?? 0,
        amountFormatted: top.params.amountFormatted ?? "0",
        cashbackPaise: top.params.cashbackPaise ?? 0,
        feePaise: top.params.feePaise ?? 0,
        toPayPaise: top.params.toPayPaise ?? 0,
        merchantName: top.params.merchantName ?? "Kalyan Jewellers",
        counterName: top.params.counterName ?? "Counter 1"
      });
    }
  }
});
flushBatch();
