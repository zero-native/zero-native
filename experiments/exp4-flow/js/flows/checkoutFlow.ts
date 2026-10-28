import { defineFlow, effect, FlowInstance } from '../zn/flow';
import { http } from '../zn/http';
import { understandUpiResponse, upiResponseForBackend } from '../zn/upiResponseParser';

export interface CheckoutData {
  amountPaise: number;
  selectedApp: string;
  selectedAppName: string;
  ztc?: string;
  upiLink?: string;
  upiResult?: any;
  verifyOutcome?: any;
}

const BACKEND_URL = 'http://127.0.0.1:8787';

export const checkoutFlow = defineFlow<CheckoutData>({
  name: 'checkout',
  schemaVersion: 1,
  expiresAfter: { minutes: 15, sliding: true },
  initial: 'enteringAmount',
  data: {
    amountPaise: 50000,
    selectedApp: 'com.phonepe.app',
    selectedAppName: 'PhonePe',
  },
  steps: {
    enteringAmount: {
      on: {
        pay: async (d, payload, f) => {
          await f.go('paying', {
            amountPaise: payload?.amountPaise || d.amountPaise,
            selectedApp: payload?.pkg || d.selectedApp,
            selectedAppName: payload?.name || d.selectedAppName,
          });
        },
      },
    },

    paying: {
      // /pay is classified as 'once' with reconcile: 'verifying' (GEMINI_BRIEF §7.2)
      enter: effect('postPay', { kind: 'once', reconcile: 'verifying' }, async (d) => {
        const res = await http(`${BACKEND_URL}/transactions/pay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entered_amount: d.amountPaise,
            counter: 'Counter 1',
            payment_mode: 'UPI_INTENT',
            upi_app_id: d.selectedApp,
          }),
        });

        if (!res.ok) {
          throw new Error(`Payment initiate failed with status ${res.status}`);
        }
        const data = await res.json();
        return data;
      }),
      on: {
        payDone: async (d, res, f) => {
          await f.go('launchingUpi', {
            ztc: res.ztc,
            upiLink: res.upi_link,
          });
        },
      },
    },

    launchingUpi: {
      // Launching UPI app is classified as 'once' with reconcile: 'verifying'
      enter: effect('launchUpi', { kind: 'once', reconcile: 'verifying' }, async (d) => {
        if (typeof (globalThis as any).__zn_launchUpi === 'function') {
          (globalThis as any).__zn_launchUpi(d.selectedApp, d.selectedAppName, d.amountPaise);
        }
        return null;
      }),
      on: {
        upiResult: async (d, resultRaw, f) => {
          await f.go('verifying', { upiResult: resultRaw });
        },
      },
    },

    verifying: {
      // verify is classified as 'safe' (idempotent status check)
      enter: effect('verify', { kind: 'safe' }, async (d) => {
        const parsed = understandUpiResponse(d.upiResult);
        const upiRespString = upiResponseForBackend(parsed, d.upiResult);
        const isSuccess = parsed.status === 'VERIFY';

        const res = await http(`${BACKEND_URL}/transactions/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            _ztc: d.ztc || '',
            _success: String(isSuccess),
          },
          body: JSON.stringify({
            data: 'test_token',
            pay_type: 'UPI_INTENT',
            retry_count: 0,
            upi_response: upiRespString,
          }),
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
          if (outcome === 'SUCCESS') {
            await f.go('success', { verifyOutcome: res });
          } else if (outcome === 'CANCELLED') {
            await f.go('cancelled', { verifyOutcome: res });
          } else {
            await f.go('failed', { verifyOutcome: res });
          }
        },
      },
    },

    success: {},
    cancelled: {
      on: {
        retry: async (d, _, f) => {
          await f.go('enteringAmount');
        },
      },
    },
    failed: {
      on: {
        retry: async (d, _, f) => {
          await f.go('enteringAmount');
        },
      },
    },
  },
});
