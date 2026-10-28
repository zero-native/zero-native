// zn/runtime.ts
var nextNodeId = 1;
function allocateNodeId() {
  return nextNodeId++;
}
function ensureNodeIdAbove(id) {
  if (id >= nextNodeId) {
    nextNodeId = id + 1;
  }
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
var nextIntervalId = 1;
var activeIntervals = new Map;
function setIntervalPolyfill(fn, intervalMs) {
  const handleId = nextIntervalId++;
  let currentTimeoutId = null;
  let isCancelled = false;
  function tick() {
    if (isCancelled)
      return;
    fn();
    if (!isCancelled) {
      currentTimeoutId = setTimeoutPolyfill(tick, intervalMs);
    }
  }
  currentTimeoutId = setTimeoutPolyfill(tick, intervalMs);
  activeIntervals.set(handleId, () => {
    isCancelled = true;
    if (currentTimeoutId !== null) {
      clearTimeoutPolyfill(currentTimeoutId);
      currentTimeoutId = null;
    }
  });
  return handleId;
}
function clearIntervalPolyfill(handleId) {
  const cancel = activeIntervals.get(handleId);
  if (cancel) {
    cancel();
    activeIntervals.delete(handleId);
  }
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
  },
  reset(route = "/amount", params = {}) {
    const entryId = 0;
    const newEntry = { route, params, entryId };
    backStack.set([newEntry]);
    queueOp(["nav", "reset", route, params, entryId]);
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
var TransactionList = "TransactionList";
var Row = "Row";
var Box = "Box";
var Text = "Text";
var Pressable = "Pressable";
var Spacer = "Spacer";
var Image = "Image";
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
  let nodeId;
  if (props && typeof props._rootId === "number") {
    nodeId = props._rootId;
    ensureNodeIdAbove(nodeId);
  } else {
    nodeId = allocateNodeId();
  }
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
      name: "⚡ ZeroBill SuperStore (Fast1!)",
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
    setAmountStr((prev) => {
      if (prev === "0" || prev === "")
        return "0";
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
  })), /* @__PURE__ */ h(Row, {
    align: "center"
  }, /* @__PURE__ */ h(Pressable, {
    paddingHorizontal: 10,
    paddingVertical: 6,
    radius: 8,
    bg: "#F1F5F9",
    pressedScale: 0.94,
    onPress: () => nav.push("/passbook")
  }, /* @__PURE__ */ h(Text, {
    text: "\uD83D\uDCDC Passbook",
    size: 12,
    weight: "bold",
    color: Colors.textPrimary
  })), /* @__PURE__ */ h(Spacer, {
    width: 8
  }), /* @__PURE__ */ h(Pressable, {
    padding: 8,
    pressedScale: 0.92,
    haptic: "light"
  }, /* @__PURE__ */ h(Text, {
    text: "%",
    size: 20,
    weight: "bold",
    color: Colors.primary
  })))), /* @__PURE__ */ h(Column, {
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
    text: () => isPayActive() ? `Pay Now (₹${financials().toPay}) →` : "⚡ TAP A DIGIT TO BEGIN",
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

// zn/flow.ts
function effect2(id, config, execute) {
  if ((config.kind === "once" || config.kind === "keyed") && !config.reconcile) {
    throw new Error(`Effect '${id}' of kind '${config.kind}' MUST declare a 'reconcile' step.`);
  }
  return {
    id,
    kind: config.kind,
    reconcile: config.reconcile,
    execute
  };
}
var activeAdapter = {
  save(state) {
    if (typeof globalThis.__zn_flow_save === "function") {
      globalThis.__zn_flow_save(JSON.stringify(state));
    }
  },
  load(name) {
    if (typeof globalThis.__zn_flow_load === "function") {
      const raw = globalThis.__zn_flow_load(name);
      return raw ? JSON.parse(raw) : null;
    }
    return null;
  },
  delete(name) {
    if (typeof globalThis.__zn_flow_delete === "function") {
      globalThis.__zn_flow_delete(name);
    }
  }
};
class FlowInstance {
  state;
  config;
  isDestroyed = false;
  inEffectExecution = false;
  constructor(config, existingState) {
    this.config = config;
    const now = Date.now();
    const expiryMs = config.expiresAfter?.seconds !== undefined ? config.expiresAfter.seconds * 1000 : (config.expiresAfter?.minutes ?? 15) * 60 * 1000;
    if (existingState) {
      this.state = existingState;
    } else {
      this.state = {
        flowId: `flow_${config.name}_${now}_${Math.random().toString(36).substring(2, 8)}`,
        name: config.name,
        schemaVersion: config.schemaVersion,
        step: config.initial,
        data: JSON.parse(JSON.stringify(config.data)),
        updatedAt: now,
        expiresAt: now + expiryMs,
        effects: {}
      };
      this.persist();
    }
  }
  get step() {
    return this.state.step;
  }
  get data() {
    return this.state.data;
  }
  persist() {
    const now = Date.now();
    this.state.updatedAt = now;
    if (this.config.expiresAfter?.sliding !== false) {
      const expiryMs = this.config.expiresAfter?.seconds !== undefined ? this.config.expiresAfter.seconds * 1000 : (this.config.expiresAfter?.minutes ?? 15) * 60 * 1000;
      this.state.expiresAt = now + expiryMs;
    }
    activeAdapter.save(this.state);
  }
  async go(nextStep, dataPatch) {
    if (this.isDestroyed)
      return;
    const stepDef = this.config.steps[nextStep];
    if (!stepDef) {
      throw new Error(`Unknown step '${nextStep}' in flow '${this.config.name}'`);
    }
    if (dataPatch) {
      this.state.data = { ...this.state.data, ...dataPatch };
    }
    this.state.step = nextStep;
    this.persist();
    if (stepDef.enter) {
      if (typeof stepDef.enter === "function") {
        await stepDef.enter(this.state.data, this);
      } else {
        await this.runEffect(stepDef.enter);
      }
    }
  }
  async runEffect(effectHandler) {
    const effectId = effectHandler.id;
    const now = Date.now();
    const key = effectHandler.kind === "keyed" ? `${this.state.flowId}_${effectId}_${this.state.step}` : undefined;
    const record = {
      id: effectId,
      kind: effectHandler.kind,
      status: "started",
      key,
      at: now,
      reconcile: effectHandler.reconcile
    };
    this.state.effects[effectId] = record;
    this.persist();
    this.inEffectExecution = true;
    try {
      const result = await effectHandler.execute(this.state.data, key);
      this.state.effects[effectId] = {
        ...record,
        status: "done",
        result
      };
      this.persist();
      this.inEffectExecution = false;
      return result;
    } catch (err) {
      this.state.effects[effectId] = {
        ...record,
        status: "failed",
        error: String(err?.message || err)
      };
      this.persist();
      this.inEffectExecution = false;
      throw err;
    }
  }
  async dispatch(event, payload) {
    if (this.isDestroyed)
      return;
    const currentStepDef = this.config.steps[this.state.step];
    if (!currentStepDef || !currentStepDef.on || !currentStepDef.on[event]) {
      return;
    }
    await currentStepDef.on[event](this.state.data, payload, this);
  }
  drop() {
    this.isDestroyed = true;
    activeAdapter.delete(this.config.name);
  }
}
function defineFlow(config) {
  for (const [stepName, step] of Object.entries(config.steps)) {
    if (step.enter && typeof step.enter !== "function") {
      const eff = step.enter;
      if ((eff.kind === "once" || eff.kind === "keyed") && !eff.reconcile) {
        throw new Error(`Step '${stepName}' in flow '${config.name}' has '${eff.kind}' effect '${eff.id}' without a 'reconcile' step.`);
      }
    }
  }
  return {
    config,
    start(initialData) {
      const instance = new FlowInstance({
        ...config,
        data: { ...config.data, ...initialData }
      });
      return instance;
    },
    restore(savedState, nativeCachedResult) {
      if (!savedState) {
        return { status: "dropped", reason: "no_saved_state" };
      }
      const now = Date.now();
      const hasUnsafeEffectStarted = Object.values(savedState.effects).some((eff) => (eff.kind === "once" || eff.kind === "keyed") && (eff.status === "started" || eff.status === "done"));
      if (now > savedState.expiresAt) {
        if (!hasUnsafeEffectStarted) {
          activeAdapter.delete(config.name);
          return { status: "dropped", reason: "expired_safe" };
        }
        return {
          status: "reconcile",
          reconcileStep: "verifying",
          reason: "expired_with_in_flight_effects"
        };
      }
      let currentData = savedState.data;
      if (savedState.schemaVersion < config.schemaVersion) {
        try {
          if (!config.migrate)
            throw new Error("No migrations declared");
          for (let v = savedState.schemaVersion;v < config.schemaVersion; v++) {
            if (config.migrate[v]) {
              currentData = config.migrate[v](currentData);
            } else {
              throw new Error(`Missing migration for schema v${v}`);
            }
          }
          savedState.data = currentData;
          savedState.schemaVersion = config.schemaVersion;
        } catch (migErr) {
          if (hasUnsafeEffectStarted) {
            return { status: "reconcile", reconcileStep: "verifying", reason: "migration_failed_in_flight" };
          }
          activeAdapter.delete(config.name);
          return { status: "dropped", reason: "migration_failed" };
        }
      }
      if (nativeCachedResult !== undefined && nativeCachedResult !== null) {
        for (const eff of Object.values(savedState.effects)) {
          if (eff.status === "started" && eff.kind === "once") {
            eff.status = "done";
            eff.result = nativeCachedResult;
          }
        }
      }
      for (const eff of Object.values(savedState.effects)) {
        if (eff.status === "started") {
          if (eff.kind === "once") {
            savedState.step = eff.reconcile || "verifying";
          }
        }
      }
      if (savedState.step === "launchingUpi" || savedState.step === "paying") {
        savedState.step = "verifying";
      }
      const instance = new FlowInstance(config, savedState);
      return { status: "active", flow: instance };
    }
  };
}

// zn/http.ts
var nextReqId = 1;
var pendingRequests = new Map;
function http(url, options = {}) {
  const method = options.method || "GET";
  const headersJson = JSON.stringify(options.headers || {});
  const bodyJson = options.body || "";
  return new Promise((resolve, reject) => {
    const id = nextReqId++;
    pendingRequests.set(id, { resolve, reject });
    if (typeof globalThis.__zn_http === "function") {
      globalThis.__zn_http(id, method, url, headersJson, bodyJson);
    } else {
      fetch(url, {
        method,
        headers: options.headers,
        body: options.body
      }).then(async (res) => {
        const txt = await res.text();
        resolve({
          status: res.status,
          ok: res.ok,
          text: async () => txt,
          json: async () => JSON.parse(txt)
        });
      }).catch(reject);
    }
  });
}
globalThis.__zn_httpResponse = (reqId, status, body, error) => {
  const pending = pendingRequests.get(reqId);
  if (!pending)
    return;
  pendingRequests.delete(reqId);
  if (error && status === 0) {
    pending.reject(new Error(error));
  } else {
    pending.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
      json: async () => JSON.parse(body)
    });
  }
};

// zn/upiResponseParser.ts
function hasNonAscii(s) {
  for (let i = 0;i < s.length; i++) {
    if (s.charCodeAt(i) > 127)
      return true;
  }
  return false;
}
function dartUriDecode(s, plusToSpace) {
  const simple = !hasNonAscii(s) && !s.includes("%") && !(plusToSpace && s.includes("+"));
  if (simple)
    return s;
  if (hasNonAscii(s))
    throw new Error("Illegal percent encoding in URI");
  return decodeURIComponent(plusToSpace ? s.replace(/\+/g, " ") : s);
}
function dartSplitQueryString(query) {
  const map = new Map;
  for (const element of query.split("&")) {
    const index = element.indexOf("=");
    if (index === -1) {
      if (element !== "")
        map.set(dartUriDecode(element, true), "");
    } else if (index !== 0) {
      map.set(dartUriDecode(element.substring(0, index), true), dartUriDecode(element.substring(index + 1), true));
    }
  }
  return map;
}
function dartToString(value) {
  if (value === null || value === undefined)
    return "null";
  if (typeof value === "string")
    return value;
  if (typeof value === "object") {
    if (Array.isArray(value))
      return `[${value.map(dartToString).join(", ")}]`;
    const entries = Object.entries(value);
    return `{${entries.map(([k, v]) => `${k}: ${dartToString(v)}`).join(", ")}}`;
  }
  return String(value);
}
function ensureIntOrNull(value) {
  if (value === null || value === undefined)
    return null;
  if (typeof value === "number")
    return Number.isInteger(value) ? value : null;
  const s = String(value);
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
}
function ensureStringOrNull(value) {
  if (value === null || value === undefined)
    return null;
  return dartToString(value);
}
function manualSplit(raw, put) {
  for (const pair of raw.split("&")) {
    if (pair.includes("=")) {
      const parts = pair.split("=");
      put(parts[0].toUpperCase(), parts.slice(1).join("="));
    }
  }
}
function understandUpiResponse(event) {
  if (event === null || event === undefined) {
    return { status: "CANCELLED", message: "No response from UPI app", response: null };
  }
  try {
    let resultCode = null;
    let explicitStatus = null;
    const responseKeyMap = new Map;
    if (typeof event === "object" && !Array.isArray(event)) {
      const map = event;
      resultCode = ensureIntOrNull(map.resultCode);
      explicitStatus = ensureStringOrNull(map.Status) ?? ensureStringOrNull(map.STATUS) ?? ensureStringOrNull(map.status);
      for (const [key, value] of Object.entries(map)) {
        if (key !== "response" && value !== null && value !== undefined) {
          responseKeyMap.set(key.toUpperCase(), dartToString(value));
        }
      }
      const nested = map.response;
      const putIfAbsent = (k, v) => {
        if (!responseKeyMap.has(k))
          responseKeyMap.set(k, v);
      };
      if (nested !== null && nested !== undefined && dartToString(nested) !== "") {
        if (typeof nested === "object" && !Array.isArray(nested)) {
          for (const [k, v] of Object.entries(nested)) {
            putIfAbsent(k.toUpperCase(), dartToString(v));
          }
        } else if (typeof nested === "string") {
          try {
            const decoded = dartUriDecode(nested, false);
            for (const [k, v] of dartSplitQueryString(decoded))
              putIfAbsent(k.toUpperCase(), v);
          } catch {
            manualSplit(nested, putIfAbsent);
          }
        }
      }
    } else if (typeof event === "string") {
      if (event !== "" && event !== "null") {
        try {
          const decoded = dartUriDecode(event, false);
          for (const [k, v] of dartSplitQueryString(decoded))
            responseKeyMap.set(k.toUpperCase(), v);
        } catch {
          manualSplit(event, (k, v) => responseKeyMap.set(k, v));
        }
      }
    }
    const responseString = responseKeyMap.size > 0 ? Array.from(responseKeyMap.entries()).map(([k, v]) => `${k}=${v}`).join("&") : dartToString(event);
    const finalStatus = (explicitStatus ?? responseKeyMap.get("STATUS") ?? responseKeyMap.get("STATUS_CODE") ?? "").toUpperCase().trim();
    const responseCode = (responseKeyMap.get("RESPONSECODE") ?? responseKeyMap.get("RESPONSE_CODE") ?? responseKeyMap.get("RES_CODE") ?? "").toUpperCase().trim();
    const approvalRefNo = (responseKeyMap.get("APPROVALREFNO") ?? responseKeyMap.get("APPROVAL_REF_NO") ?? responseKeyMap.get("RRN") ?? responseKeyMap.get("REFNO") ?? "").trim();
    const txnId = (responseKeyMap.get("TXNID") ?? responseKeyMap.get("TXN_ID") ?? "").trim();
    if (responseCode === "02" || responseCode === "U69" || responseCode === "ZD") {
      return {
        status: "CANCELLED",
        message: `Cancelled from UPI app (responseCode: ${responseCode})`,
        response: responseString
      };
    }
    if (responseCode === "00" || responseCode === "0") {
      return { status: "VERIFY", message: `Success (responseCode: ${responseCode})`, response: responseString };
    }
    switch (finalStatus) {
      case "USER_DROPPED":
      case "CANCELLED":
      case "CANCELED":
      case "DECLINED":
        return { status: "CANCELLED", message: "Cancelled from UPI app", response: responseString };
      case "FAILED":
      case "FAILURE":
      case "FAIL":
        return { status: "FAILED", message: "Failed", response: responseString };
      case "SUCCESS":
        return { status: "VERIFY", message: "Success", response: responseString };
    }
    if (approvalRefNo !== "" && approvalRefNo !== "null") {
      return { status: "VERIFY", message: `Approval ref found: ${approvalRefNo}`, response: responseString };
    }
    const isSubmittingOrPending = finalStatus === "SUBMITTED" || finalStatus === "PENDING" || finalStatus === "DEEMED" || finalStatus === "IN-PROGRESS" || finalStatus === "IN_PROGRESS";
    if (isSubmittingOrPending) {
      const hasValidTxnId = txnId !== "" && txnId !== "null";
      if (resultCode === 0 && !hasValidTxnId) {
        return { status: "CANCELLED", message: "Cancelled from UPI app", response: responseString };
      }
      return { status: "VERIFY", message: `In-flight: ${finalStatus}`, response: responseString };
    }
    if (resultCode === 0) {
      return { status: "CANCELLED", message: "Cancelled from UPI app", response: responseString };
    }
    return { status: "VERIFY", message: "", response: responseString };
  } catch {
    return { status: "FAILED", message: "Unable to parse application response", response: dartToString(event) };
  }
}
function upiResponseForBackend(parsed, event) {
  return parsed.response ?? dartToString(event);
}

// flows/checkoutFlow.ts
var BACKEND_URL = "http://127.0.0.1:8787";
var getProp = (key) => {
  return typeof globalThis.__zn_getProp === "function" ? globalThis.__zn_getProp(key) || "" : "";
};
var debugExpiresSec = parseInt(getProp("debug.zn.expires") || "0", 10);
var debugSchemaVer = parseInt(getProp("debug.zn.schema") || "1", 10);
var debugMigrate = getProp("debug.zn.migrate");
var migrations = {};
if (debugMigrate === "v1") {
  migrations[1] = (old) => ({
    ...old,
    migratedV1ToV2: true
  });
}
var checkoutFlow = defineFlow({
  name: "checkout",
  schemaVersion: debugSchemaVer > 0 ? debugSchemaVer : 1,
  expiresAfter: debugExpiresSec > 0 ? { seconds: debugExpiresSec, sliding: false } : { minutes: 15, sliding: true },
  migrate: debugSchemaVer > 1 ? migrations : undefined,
  initial: "enteringAmount",
  data: {
    amountPaise: 50000,
    selectedApp: "com.phonepe.app",
    selectedAppName: "PhonePe"
  },
  steps: {
    enteringAmount: {
      on: {
        pay: async (d, payload, f) => {
          await f.go("paying", {
            amountPaise: payload?.amountPaise || d.amountPaise,
            selectedApp: payload?.pkg || d.selectedApp,
            selectedAppName: payload?.name || d.selectedAppName
          });
        }
      }
    },
    paying: {
      enter: effect2("postPay", { kind: "once", reconcile: "verifying" }, async (d) => {
        const res = await http(`${BACKEND_URL}/transactions/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entered_amount: d.amountPaise,
            counter: "Counter 1",
            payment_mode: "UPI_INTENT",
            upi_app_id: d.selectedApp
          })
        });
        if (!res.ok) {
          throw new Error(`Payment initiate failed with status ${res.status}`);
        }
        const data = await res.json();
        if (typeof globalThis.__zn_checkCrash === "function") {
          globalThis.__zn_checkCrash("S4c");
        }
        return data;
      }),
      on: {
        payDone: async (d, res, f) => {
          await f.go("launchingUpi", {
            ztc: res.ztc,
            upiLink: res.upi_link
          });
        }
      }
    },
    launchingUpi: {
      enter: effect2("launchUpi", { kind: "once", reconcile: "verifying" }, async (d) => {
        if (typeof globalThis.__zn_launchUpi === "function") {
          globalThis.__zn_launchUpi(d.selectedApp, d.selectedAppName, d.amountPaise);
        }
        return null;
      }),
      on: {
        upiResult: async (d, resultRaw, f) => {
          await f.go("verifying", { upiResult: resultRaw });
        }
      }
    },
    verifying: {
      enter: effect2("verify", { kind: "safe" }, async (d) => {
        const parsed = understandUpiResponse(d.upiResult);
        const upiRespString = upiResponseForBackend(parsed, d.upiResult);
        const isSuccess = parsed.status === "VERIFY";
        const res = await http(`${BACKEND_URL}/transactions/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            _ztc: d.ztc || "",
            _success: String(isSuccess)
          },
          body: JSON.stringify({
            data: "test_token",
            pay_type: "UPI_INTENT",
            retry_count: 0,
            upi_response: upiRespString
          })
        });
        if (!res.ok) {
          throw new Error(`Verify failed: status ${res.status}`);
        }
        const data = await res.json();
        return { verifyData: data, parsedStatus: parsed.status };
      }),
      on: {
        verifyDone: async (d, res, f) => {
          const outcome = res.verifyData?.status || res.parsedStatus;
          if (outcome === "SUCCESS") {
            await f.go("success", { verifyOutcome: res });
          } else if (outcome === "CANCELLED") {
            await f.go("cancelled", { verifyOutcome: res });
          } else {
            await f.go("failed", { verifyOutcome: res });
          }
        }
      }
    },
    success: {},
    cancelled: {
      on: {
        retry: async (d, _, f) => {
          await f.go("enteringAmount");
        }
      }
    },
    failed: {
      on: {
        retry: async (d, _, f) => {
          await f.go("enteringAmount");
        }
      }
    }
  }
});

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
  const onSelectUpiApp = async (pkg, name) => {
    if (isLaunching())
      return;
    selectedApp.set(pkg);
    selectedAppName.set(name);
    isLaunching.set(true);
    startJsGlide();
    try {
      const flow = checkoutFlow.start({
        amountPaise: props.toPayPaise,
        selectedApp: pkg,
        selectedAppName: name
      });
      globalThis.__activeFlow = flow;
      console.log(`[FLOW] Starting /pay for ${pkg}...`);
      await flow.dispatch("pay", { amountPaise: props.toPayPaise, pkg, name });
      const payEffect = flow.state.effects["postPay"];
      if (payEffect && payEffect.status === "done") {
        console.log(`[FLOW] /pay successful (ztc=${payEffect.result?.ztc}). Launching UPI...`);
        await flow.dispatch("payDone", payEffect.result);
      }
    } catch (err) {
      console.error("[FLOW] Error during checkout flow initiation", err);
    }
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
  }, (() => {
    let appsList = [];
    if (typeof globalThis.__zn_getUpiApps === "function") {
      try {
        const raw = globalThis.__zn_getUpiApps();
        appsList = JSON.parse(raw);
      } catch (_) {}
    }
    if (!appsList || appsList.length === 0) {
      appsList = [
        {
          packageName: "p2pdops.android.p2pupiapp",
          appName: "P2P Mock UPI",
          iconUri: "zn://app-icon/p2pdops.android.p2pupiapp"
        }
      ];
    }
    return appsList.map((app) => /* @__PURE__ */ h(UpiTile, {
      key: app.packageName,
      name: app.appName,
      pkg: app.packageName,
      icon: app.iconUri,
      badge: app.packageName === "p2pdops.android.p2pupiapp" ? "Safe Test" : "Installed",
      isSelected: () => selectedApp() === app.packageName,
      isLaunching: () => isLaunching() && selectedApp() === app.packageName,
      jsProgress,
      onSelect: () => onSelectUpiApp(app.packageName, app.appName)
    }));
  })())));
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
  }, props.icon ? /* @__PURE__ */ h(Image, {
    src: props.icon,
    width: 44,
    height: 44,
    radius: 22
  }) : /* @__PURE__ */ h(Box, {
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

// screens/VerifyingScreen.tsx
function VerifyingScreen(props) {
  const [statusText, setStatusText] = signal(props.statusText || "Verifying payment with bank...");
  const merchant = props.merchantName || "Kalyan Jewellers";
  const activeFlow = globalThis.__activeFlow;
  const existingVerify = activeFlow?.state?.effects?.["verify"];
  const applyOutcome = (res) => {
    const outcome = res?.verifyData?.status || res?.parsedStatus || res?.status;
    if (outcome === "SUCCESS") {
      setStatusText("Payment Successful!");
    } else if (outcome === "CANCELLED") {
      setStatusText("Payment Cancelled");
    } else if (outcome === "FAILED") {
      setStatusText("Payment Failed");
    }
  };
  if (existingVerify && existingVerify.status === "done" && existingVerify.result) {
    applyOutcome(existingVerify.result);
  } else if (activeFlow) {
    let resolved = false;
    const timer = setInterval(() => {
      const v = activeFlow?.state?.effects?.["verify"];
      if (v && v.status === "done" && v.result) {
        resolved = true;
        clearInterval(timer);
        applyOutcome(v.result);
      } else if (v && v.status === "failed") {
        resolved = true;
        clearInterval(timer);
        setStatusText("Payment Failed");
      }
    }, 100);
    setTimeout(() => {
      if (!resolved) {
        clearInterval(timer);
        const upiRes = activeFlow?.state?.data?.upiResult || activeFlow?.data?.upiResult;
        const isSuccess = upiRes?.Status === "SUCCESS" && (upiRes?.responseCode === "00" || upiRes?.responseCode === "0");
        const isCancelled = upiRes?.responseCode === "U69" || upiRes?.resultCode === 0;
        if (isSuccess)
          setStatusText("Payment Successful!");
        else if (isCancelled)
          setStatusText("Payment Cancelled");
        else
          setStatusText("Payment Failed");
      }
    }, 1800);
  } else {
    setTimeout(() => {
      const upiRes = activeFlow?.state?.data?.upiResult;
      const isSuccess = upiRes?.Status === "SUCCESS" && (upiRes?.responseCode === "00" || upiRes?.responseCode === "0");
      http("http://127.0.0.1:8787/transactions/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          _ztc: activeFlow?.state?.data?.ztc || "restored_ztc",
          _success: String(isSuccess)
        },
        body: JSON.stringify({
          data: "token",
          pay_type: "UPI_INTENT",
          retry_count: 0,
          upi_response: typeof upiRes === "object" ? JSON.stringify(upiRes) : String(upiRes || "RESULTCODE=0")
        })
      }).then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          applyOutcome(data);
        }
      }).catch(() => {});
    }, 400);
  }
  const iconText = computed(() => {
    const s = statusText();
    if (s.includes("Successful"))
      return "✅";
    if (s.includes("Failed"))
      return "❌";
    if (s.includes("Cancelled"))
      return "\uD83D\uDEAB";
    return "⏳";
  });
  const iconBg = computed(() => {
    const s = statusText();
    if (s.includes("Successful"))
      return "#ECFDF5";
    if (s.includes("Failed"))
      return "#FEF2F2";
    if (s.includes("Cancelled"))
      return "#F1F5F9";
    return "#EEF2FF";
  });
  const cardTitle = computed(() => {
    const s = statusText();
    if (s.includes("Successful"))
      return "Payment Received";
    if (s.includes("Failed"))
      return "Payment Declined";
    if (s.includes("Cancelled"))
      return "Payment Aborted";
    return "Safe Recovery Active";
  });
  const cardDesc = computed(() => {
    const s = statusText();
    if (s.includes("Successful"))
      return "Transaction confirmed by bank. Flow completed safely.";
    if (s.includes("Failed"))
      return "The issuing bank declined this payment. No amount was deducted.";
    if (s.includes("Cancelled"))
      return "You cancelled the payment in the UPI app. Your balance is safe.";
    return "Your payment state is safely saved in FlowStore. Checking the final status with server.";
  });
  return /* @__PURE__ */ h(Column, {
    _rootId: props._rootId,
    fill: true,
    bg: "#F8FAFC",
    align: "center",
    justify: "center",
    padding: 24
  }, /* @__PURE__ */ h(Box, {
    width: 72,
    height: 72,
    radius: 36,
    bg: () => iconBg(),
    align: "center",
    justify: "center"
  }, /* @__PURE__ */ h(Text, {
    text: () => iconText(),
    size: 32
  })), /* @__PURE__ */ h(Spacer, {
    height: 24
  }), /* @__PURE__ */ h(Text, {
    text: () => statusText(),
    size: 20,
    weight: "bold",
    color: "#1E293B",
    align: "center"
  }), /* @__PURE__ */ h(Spacer, {
    height: 8
  }), /* @__PURE__ */ h(Text, {
    text: merchant,
    size: 15,
    color: "#64748B",
    align: "center"
  }), /* @__PURE__ */ h(Spacer, {
    height: 32
  }), /* @__PURE__ */ h(Box, {
    bg: "#FFFFFF",
    radius: 16,
    padding: 16,
    width: 300,
    border: 1,
    borderColor: "#E2E8F0"
  }, /* @__PURE__ */ h(Column, {
    gap: 12
  }, /* @__PURE__ */ h(Text, {
    text: () => cardTitle(),
    size: 14,
    weight: "bold",
    color: "#2563EB"
  }), /* @__PURE__ */ h(Text, {
    text: () => cardDesc(),
    size: 13,
    color: "#475569"
  }))), /* @__PURE__ */ h(Spacer, {
    height: 40
  }), /* @__PURE__ */ h(Pressable, {
    onPress: () => {
      nav.reset("/amount");
    }
  }, /* @__PURE__ */ h(Box, {
    bg: "#F1F5F9",
    radius: 12,
    padding: 14,
    width: 200,
    align: "center"
  }, /* @__PURE__ */ h(Text, {
    text: "Return to Home",
    size: 14,
    weight: "bold",
    color: "#475569"
  }))));
}

// screens/PassbookScreen.tsx
var MERCHANTS = [
  { name: "Swiggy", cat: "Food & Dining", amt: "₹340.00", cr: false },
  { name: "ZeroBill Cashback", cat: "Rewards", amt: "₹50.00", cr: true },
  { name: "Starbucks Coffee", cat: "Beverages", amt: "₹420.00", cr: false },
  { name: "Zepto 10-Min", cat: "Groceries", amt: "₹289.00", cr: false },
  { name: "Uber India", cat: "Travel", amt: "₹195.00", cr: false },
  { name: "Flipkart Internet", cat: "Shopping", amt: "₹1,249.00", cr: false },
  { name: "Kalyan Jewellers", cat: "Jewellery", amt: "₹5,400.00", cr: false },
  { name: "Zomato Limited", cat: "Dining", amt: "₹612.00", cr: false },
  { name: "Google Play Store", cat: "Subscriptions", amt: "₹179.00", cr: false },
  { name: "Apollo Pharmacy", cat: "Healthcare", amt: "₹450.00", cr: false }
];
function generate10000Transactions() {
  const items = [];
  for (let i = 1;i <= 1e4; i++) {
    const template = MERCHANTS[(i - 1) % MERCHANTS.length];
    items.push({
      id: i,
      merchant: `${template.name} #${i}`,
      category: template.cat,
      time: `Oct ${28 - (i / 350 | 0)}, 2026 • ${i * 7 % 12 + 1}:${i * 13 % 60 < 10 ? "0" : ""}${i * 13 % 60} ${i % 2 === 0 ? "PM" : "AM"}`,
      amount: template.cr ? `+${template.amt}` : `-${template.amt}`,
      isCredit: template.cr
    });
  }
  return items;
}
var ALL_TRANSACTIONS = generate10000Transactions();
function PassbookScreen(props) {
  return /* @__PURE__ */ h(Column, {
    _rootId: props._rootId,
    fill: true,
    bg: Colors.background,
    paddingHorizontal: 16,
    paddingTop: 16
  }, /* @__PURE__ */ h(Row, {
    height: 52,
    align: "center",
    justify: "space-between",
    marginBottom: 12
  }, /* @__PURE__ */ h(Row, {
    align: "center"
  }, /* @__PURE__ */ h(Pressable, {
    width: 40,
    height: 40,
    radius: 20,
    bg: Colors.surface,
    align: "center",
    justify: "center",
    pressedScale: 0.92,
    onPress: () => nav.pop()
  }, /* @__PURE__ */ h(Text, {
    text: "←",
    size: 20,
    weight: "bold",
    color: Colors.textPrimary
  })), /* @__PURE__ */ h(Spacer, {
    width: 12
  }), /* @__PURE__ */ h(Column, null, /* @__PURE__ */ h(Text, {
    text: "Passbook",
    size: 20,
    weight: "bold",
    color: Colors.textPrimary
  }), /* @__PURE__ */ h(Text, {
    text: "10,000 Transactions (Zero-DOM)",
    size: 12,
    color: Colors.textMuted
  }))), /* @__PURE__ */ h(Box, {
    bg: "#DCFCE7",
    radius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4
  }, /* @__PURE__ */ h(Text, {
    text: "⚡ 10K ITEMS",
    size: 11,
    weight: "bold",
    color: "#16A34A"
  }))), /* @__PURE__ */ h(TransactionList, {
    fill: true,
    gap: 8,
    data: ALL_TRANSACTIONS
  }));
}

// main.tsx
var currentFlow = null;
queueOp(["c", 0, "Box"]);
queueOp(["p", 0, "fill", true]);
var initialScreen = "/amount";
var initialParams = {};
if (typeof globalThis.__zn_flow_load === "function") {
  try {
    const raw = globalThis.__zn_flow_load("checkout");
    if (raw) {
      const savedState = JSON.parse(raw);
      console.log(`[FLOW_RESTORE] Found saved flow 'checkout' at step '${savedState.step}'`);
      const outcome = checkoutFlow.restore(savedState);
      if (outcome.status === "active" && outcome.flow) {
        currentFlow = outcome.flow;
        globalThis.__activeFlow = currentFlow;
        console.log(`[FLOW_RESTORE] Successfully restored flow to step '${currentFlow.step}'`);
        const upiResult = savedState.data?.upiResult || savedState.effects?.launchUpi?.result || currentFlow.data.upiResult;
        const isRealUpiResult = upiResult && (upiResult.response || upiResult.Status || upiResult.responseCode !== undefined);
        if (isRealUpiResult && currentFlow.step !== "success" && currentFlow.step !== "cancelled" && currentFlow.step !== "failed") {
          currentFlow.data.upiResult = upiResult;
          currentFlow.go("verifying", { upiResult }).then(async () => {
            const verifyEffect = currentFlow?.state?.effects?.["verify"];
            if (verifyEffect && verifyEffect.status === "done") {
              await currentFlow?.dispatch("verifyDone", verifyEffect.result);
            }
          }).catch((err) => {
            console.error("[FLOW_RESTORE] Verify effect error", err);
          });
        }
        if (currentFlow.step === "verifying" || currentFlow.step === "paying" || currentFlow.step === "launchingUpi" || currentFlow.step === "success") {
          initialScreen = "/verifying";
          initialParams = {
            statusText: currentFlow.step === "success" ? "Payment Successful!" : "Checking payment status...",
            merchantName: "Kalyan Jewellers"
          };
        }
      } else if (outcome.status === "reconcile") {
        console.log(`[FLOW_RESTORE] Flow expired with in-flight actions. Opening in reconcile!`);
        initialScreen = "/verifying";
        initialParams = {
          statusText: "Checking last payment status...",
          merchantName: "Kalyan Jewellers"
        };
      }
    }
  } catch (err) {
    console.error("[FLOW_RESTORE] Failed to parse saved flow state", err);
  }
}
var amountRootId = AmountScreen({
  onBack: () => {
    console.log("[JS] Root back pressed");
  }
});
queueOp(["i", 0, amountRootId, 0]);
if (initialScreen === "/verifying") {
  nav.push("/verifying", {
    statusText: initialParams.statusText,
    merchantName: initialParams.merchantName
  });
}
var mountedEntryIds = new Set([0]);
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
    } else if (top.route === "/verifying") {
      VerifyingScreen({
        _rootId: top.entryId,
        statusText: top.params.statusText,
        merchantName: top.params.merchantName
      });
    } else if (top.route === "/passbook") {
      PassbookScreen({
        _rootId: top.entryId,
        onBack: () => nav.pop()
      });
    } else if (top.route === "/amount") {
      if (top.entryId !== 0) {
        const rootId = AmountScreen({ onBack: () => {} });
        queueOp(["i", top.entryId, rootId, 0]);
      }
    }
  }
});
registerEventHandler(0, "upiResult", async (parsedResult) => {
  console.log(`[JS_EVENT] Received native upiResult:`, parsedResult);
  try {
    const flow = globalThis.__activeFlow || currentFlow;
    if (flow) {
      globalThis.__activeFlow = flow;
      flow.data.upiResult = parsedResult;
      nav.replace("/verifying", {
        statusText: "Processing payment result...",
        merchantName: "Kalyan Jewellers"
      });
      flow.go("verifying", { upiResult: parsedResult }).then(async () => {
        const verifyEffect = flow.state.effects["verify"];
        if (verifyEffect && verifyEffect.status === "done") {
          await flow.dispatch("verifyDone", verifyEffect.result);
        }
      }).catch((err) => {
        console.error("[JS_EVENT] Verify effect execution error", err);
      });
    }
  } catch (err) {
    console.error("[JS_EVENT] Failed to process upiResult", err);
  }
});
registerEventHandler(0, "hardwareBack", () => {
  nav.pop();
});
flushBatch();
