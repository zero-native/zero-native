// exp4-flow/js/screens/CheckoutScreen.tsx - UPI Payment Selection & @flow integration
import { h, Column, Row, Box, Text, Pressable, Spacer, Image } from "../zn/h";
import { signal, computed, effect } from "../zn/signals";
import { nav } from "../zn/nav";
import { checkoutFlow } from "../flows/checkoutFlow";

export interface CheckoutProps {
  _rootId: number;
  amountPaise: number;
  amountFormatted: string;
  cashbackPaise: number;
  feePaise: number;
  toPayPaise: number;
  merchantName: string;
  counterName: string;
}

export function CheckoutScreen(props: CheckoutProps) {
  const selectedApp = signal<string | null>(null);
  const selectedAppName = signal<string>("");
  const isLaunching = signal(false);
  const isSlowLaunch = signal(false); // 2.4s fallback screen

  // Dual glide state:
  // Native glide runs natively inside Compose UpiProgressBar
  // JS glide runs via setTimeout every 16ms
  const jsProgress = signal(0.0);

  const startJsGlide = () => {
    jsProgress.set(0.0);
    const startTime = Date.now();

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      let p = 0.0;

      if (elapsed <= 400) {
        // Segment 1: 0% -> 60% in 400ms
        p = (elapsed / 400) * 0.60;
      } else if (elapsed <= 1000) {
        // Segment 2: 60% -> 82% in 600ms
        p = 0.60 + ((elapsed - 400) / 600) * 0.22;
      } else if (elapsed <= 2400) {
        // Segment 3: 82% -> 94% in 1400ms (asymptotic)
        p = 0.82 + ((elapsed - 1000) / 1400) * 0.12;
      } else {
        p = 0.94;
        clearInterval(interval);
      }

      jsProgress.set(Math.min(0.94, p));
    }, 16);

    // 2.4s slow launch fallback timer
    setTimeout(() => {
      if (isLaunching()) {
        isSlowLaunch.set(true);
      }
    }, 2400);
  };

  const onSelectUpiApp = async (pkg: string, name: string) => {
    if (isLaunching()) return;
    selectedApp.set(pkg);
    selectedAppName.set(name);
    isLaunching.set(true);

    // Start JS glide
    startJsGlide();

    try {
      const flow = checkoutFlow.start({
        amountPaise: props.toPayPaise,
        selectedApp: pkg,
        selectedAppName: name,
      });
      (globalThis as any).__activeFlow = flow;

      // 1. Enter 'paying' step (executes postPay effect -> POST /transactions/pay)
      console.log(`[FLOW] Starting /pay for ${pkg}...`);
      await flow.dispatch('pay', { amountPaise: props.toPayPaise, pkg, name });

      const payEffect = flow.state.effects['postPay'];
      if (payEffect && payEffect.status === 'done') {
        // 2. Enter 'launchingUpi' step
        console.log(`[FLOW] /pay successful (ztc=${payEffect.result?.ztc}). Launching UPI...`);
        await flow.dispatch('payDone', payEffect.result);
      }
    } catch (err) {
      console.error('[FLOW] Error during checkout flow initiation', err);
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

  return (
    <Column _rootId={props._rootId} fill={true} bg="#F8FAFC">
      {/* 2.4s Slow Launch Fallback Screen (FullScreen White Canvas with Logo) */}
      <Box
        fill={true}
        bg="#FFFFFF"
        align="center"
        justify="center"
        visible={() => isSlowLaunch()}
      >
        <Column align="center" gap={16}>
          <Box
            width={100}
            height={100}
            radius={24}
            bg="#EEF2F6"
            align="center"
            justify="center"
            border={1}
            borderColor="#E2E8F0"
          >
            <Text
              text={() => selectedAppName().slice(0, 2).toUpperCase()}
              size={32}
              weight="bold"
              color="#3D26ED"
            />
          </Box>
          <Text
            text={() => `Opening ${selectedAppName()}...`}
            size={18}
            weight="bold"
            color="#0F172A"
          />
          <Text
            text="Please approve the payment in your UPI app"
            size={14}
            color="#64748B"
          />
        </Column>
      </Box>

      {/* Main Checkout Screen */}
      <Column
        fill={true}
        padding={20}
        gap={20}
        visible={() => !isSlowLaunch()}
      >
        {/* Top Navigation Bar with Back Button */}
        <Row align="center" gap={12} width="100%">
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
          >
            <Text text="←" size={20} weight="bold" color="#0F172A" />
          </Pressable>
          <Column>
            <Text text="Select Payment Method" size={18} weight="bold" color="#0F172A" />
            <Text text={props.merchantName} size={13} color="#64748B" />
          </Column>
        </Row>

        {/* Bill Summary Card */}
        <Column bg="#FFFFFF" radius={16} padding={16} gap={10} border={1} borderColor="#E2E8F0">
          <Row justify="space-between" align="center">
            <Text text="Bill Amount" size={14} color="#64748B" />
            <Text text={`₹${props.amountFormatted}`} size={15} weight="medium" color="#0F172A" />
          </Row>

          <Row justify="space-between" align="center">
            <Text text="🎉 ZeroBill Cashback" size={14} color="#059669" />
            <Text text={() => `-${cashbackFormatted()}`} size={15} weight="bold" color="#059669" />
          </Row>

          <Box height={1} bg="#F1F5F9" width="100%" />

          <Row justify="space-between" align="center">
            <Text text="Total to Pay" size={16} weight="bold" color="#0F172A" />
            <Text text={() => toPayFormatted()} size={20} weight="bold" color="#3D26ED" />
          </Row>
        </Column>

        {/* UPI Apps Selection Header */}
        <Column gap={4} marginTop={8}>
          <Text text="Pay via Installed UPI App" size={15} weight="bold" color="#0F172A" />
          <Text text="Tap an app to pay instantly" size={13} color="#64748B" />
        </Column>

        {/* UPI App Tiles List */}
        <Column gap={12} width="100%">
          {/* Query installed UPI apps via Argon's zn:// native resource URI scheme */}
          {(() => {
            let appsList: Array<{ packageName: string; appName: string; iconUri: string }> = [];
            const hasFn = typeof (globalThis as any).__zn_getUpiApps === "function";
            console.log("[UPI_DISCOVERY] has __zn_getUpiApps:", hasFn);
            if (hasFn) {
              try {
                const raw = (globalThis as any).__zn_getUpiApps();
                console.log("[UPI_DISCOVERY] raw return:", raw);
                appsList = JSON.parse(raw);
                console.log("[UPI_DISCOVERY] parsed count:", appsList.length);
              } catch (e: any) {
                console.log("[UPI_DISCOVERY] error:", e?.message);
              }
            }
            if (!appsList || appsList.length === 0) {
              appsList = [
                {
                  packageName: "p2pdops.android.p2pupiapp",
                  appName: "P2P Mock UPI",
                  iconUri: "zn://app-icon/p2pdops.android.p2pupiapp",
                },
              ];
            }
            console.log("[UPI_DISCOVERY] final appsList:", JSON.stringify(appsList));

            return appsList.map((app) => (
              <UpiTile
                key={app.packageName}
                name={app.appName}
                pkg={app.packageName}
                icon={app.iconUri}
                badge={app.packageName === "p2pdops.android.p2pupiapp" ? "Safe Test" : "Installed"}
                isSelected={() => selectedApp() === app.packageName}
                isLaunching={() => isLaunching() && selectedApp() === app.packageName}
                jsProgress={jsProgress}
                onSelect={() => onSelectUpiApp(app.packageName, app.appName)}
              />
            ));
          })()}
        </Column>
      </Column>
    </Column>
  );
}

// Subcomponent: UPI App Tile with Dual Progress Bar
function UpiTile(props: {
  name: string;
  pkg: string;
  icon?: string;
  badge?: string;
  isSelected: () => boolean;
  isLaunching: () => boolean;
  jsProgress: () => number;
  onSelect: () => void;
}) {
  return (
    <Pressable
      onPress={props.onSelect}
      width="100%"
      radius={16}
      bg="#FFFFFF"
      border={1}
      borderColor={() => (props.isSelected() ? "#3D26ED" : "#E2E8F0")}
      padding={16}
    >
      <Column width="100%" gap={10}>
        <Row justify="space-between" align="center" width="100%">
          <Row align="center" gap={12}>
            {/* Real App Icon via zn:// URI (Zero pixel copying) */}
            {props.icon ? (
              <Image src={props.icon} width={44} height={44} radius={22} />
            ) : (
              <Box width={44} height={44} radius={22} bg="#F1F5F9" align="center" justify="center">
                <Text text={props.name.slice(0, 1)} size={18} weight="bold" color="#3D26ED" />
              </Box>
            )}
            <Column>
              <Text text={props.name} size={15} weight="bold" color="#0F172A" />
              <Text text={props.pkg} size={11} color="#94A3B8" />
            </Column>
          </Row>

          {props.badge && (
            <Box bg="#EEF2FF" paddingHorizontal={8} paddingVertical={4} radius={6}>
              <Text text={props.badge} size={11} weight="medium" color="#4338CA" />
            </Box>
          )}
        </Row>

        {/* Dual Progress Glide Display (Visible when tile is clicked) */}
        <Column
          width="100%"
          gap={6}
          visible={() => props.isLaunching()}
        >
          {/* Bar 1: Native Compose Animatable Glide */}
          <Column gap={2}>
            <Row justify="space-between">
              <Text text="Native Compose Animatable (60 FPS during onPause)" size={10} color="#059669" />
              <Text text="Native" size={10} weight="bold" color="#059669" />
            </Row>
            {/* Custom UpiProgressBar native composable */}
            <Box width="100%" height={6} radius={3} bg="#E2E8F0">
              <UpiNativeBar isRunning={props.isLaunching} />
            </Box>
          </Column>

          {/* Bar 2: JS-driven setTimeout Glide */}
          <Column gap={2}>
            <Row justify="space-between">
              <Text text="JS Thread Glide (setTimeout 16ms op batch)" size={10} color="#2563EB" />
              <Text
                text={() => `${Math.round(props.jsProgress() * 100)}%`}
                size={10}
                weight="bold"
                color="#2563EB"
              />
            </Row>
            <Box width="100%" height={6} radius={3} bg="#E2E8F0">
              <UpiJsBar progress={props.jsProgress} />
            </Box>
          </Column>
        </Column>
      </Column>
    </Pressable>
  );
}

function UpiNativeBar(props: { isRunning: () => boolean }) {
  return <Box height={6} radius={3} bg="#059669" isNativeActive={props.isRunning} />;
}

function UpiJsBar(props: { progress: () => number }) {
  return (
    <Box
      height={6}
      radius={3}
      bg="#2563EB"
      width={() => `${Math.round(props.progress() * 100)}%`}
    />
  );
}
