import { h, Column, Box, Text, Pressable, Spacer } from "../zn/h";
import { signal, computed } from "../zn/signals";
import { nav } from "../zn/nav";
import { http } from "../zn/http";

export interface VerifyingProps {
  _rootId: number;
  statusText?: string;
  amountFormatted?: string;
  merchantName?: string;
}

export function VerifyingScreen(props: VerifyingProps) {
  const [statusText, setStatusText] = signal(props.statusText || "Verifying payment with bank...");
  const merchant = props.merchantName || "Kalyan Jewellers";

  // Check if active flow already resolved the verify outcome
  const activeFlow = (globalThis as any).__activeFlow;
  const existingVerify = activeFlow?.state?.effects?.['verify'];

  const applyOutcome = (res: any) => {
    const outcome = res?.verifyData?.status || res?.parsedStatus || res?.status;
    if (outcome === "SUCCESS") {
      setStatusText("Payment Successful!");
    } else if (outcome === "CANCELLED") {
      setStatusText("Payment Cancelled");
    } else if (outcome === "FAILED") {
      setStatusText("Payment Failed");
    }
  };

  if (existingVerify && existingVerify.status === 'done' && existingVerify.result) {
    applyOutcome(existingVerify.result);
  } else if (activeFlow) {
    let resolved = false;
    const timer = setInterval(() => {
      const v = activeFlow?.state?.effects?.['verify'];
      if (v && v.status === 'done' && v.result) {
        resolved = true;
        clearInterval(timer);
        applyOutcome(v.result);
      } else if (v && v.status === 'failed') {
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

        if (isSuccess) setStatusText("Payment Successful!");
        else if (isCancelled) setStatusText("Payment Cancelled");
        else setStatusText("Payment Failed");
      }
    }, 1800);
  } else {
    // When opened in restore without active flow instance, query mock backend
    setTimeout(() => {
      const upiRes = activeFlow?.state?.data?.upiResult;
      const isSuccess = upiRes?.Status === "SUCCESS" && (upiRes?.responseCode === "00" || upiRes?.responseCode === "0");

      http("http://127.0.0.1:8787/transactions/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "_ztc": activeFlow?.state?.data?.ztc || "restored_ztc",
          "_success": String(isSuccess),
        },
        body: JSON.stringify({
          data: "token",
          pay_type: "UPI_INTENT",
          retry_count: 0,
          upi_response: typeof upiRes === "object" ? JSON.stringify(upiRes) : String(upiRes || "RESULTCODE=0"),
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
    if (s.includes("Successful")) return "✅";
    if (s.includes("Failed")) return "❌";
    if (s.includes("Cancelled")) return "🚫";
    return "⏳";
  });

  const iconBg = computed(() => {
    const s = statusText();
    if (s.includes("Successful")) return "#ECFDF5";
    if (s.includes("Failed")) return "#FEF2F2";
    if (s.includes("Cancelled")) return "#F1F5F9";
    return "#EEF2FF";
  });

  const cardTitle = computed(() => {
    const s = statusText();
    if (s.includes("Successful")) return "Payment Received";
    if (s.includes("Failed")) return "Payment Declined";
    if (s.includes("Cancelled")) return "Payment Aborted";
    return "Safe Recovery Active";
  });

  const cardDesc = computed(() => {
    const s = statusText();
    if (s.includes("Successful")) return "Transaction confirmed by bank. Flow completed safely.";
    if (s.includes("Failed")) return "The issuing bank declined this payment. No amount was deducted.";
    if (s.includes("Cancelled")) return "You cancelled the payment in the UPI app. Your balance is safe.";
    return "Your payment state is safely saved in FlowStore. Checking the final status with server.";
  });

  return (
    <Column _rootId={props._rootId} fill={true} bg="#F8FAFC" align="center" justify="center" padding={24}>
      <Box width={72} height={72} radius={36} bg={() => iconBg()} align="center" justify="center">
        <Text text={() => iconText()} size={32} />
      </Box>

      <Spacer height={24} />

      <Text text={() => statusText()} size={20} weight="bold" color="#1E293B" align="center" />

      <Spacer height={8} />

      <Text text={merchant} size={15} color="#64748B" align="center" />

      <Spacer height={32} />

      <Box bg="#FFFFFF" radius={16} padding={16} width={300} border={1} borderColor="#E2E8F0">
        <Column gap={12}>
          <Text text={() => cardTitle()} size={14} weight="bold" color="#2563EB" />
          <Text
            text={() => cardDesc()}
            size={13}
            color="#475569"
          />
        </Column>
      </Box>

      <Spacer height={40} />

      <Pressable
        onPress={() => {
          nav.reset("/amount");
        }}
      >
        <Box bg="#F1F5F9" radius={12} padding={14} width={200} align="center">
          <Text text="Return to Home" size={14} weight="bold" color="#475569" />
        </Box>
      </Pressable>
    </Column>
  );
}
