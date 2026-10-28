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

const getProp = (key: string): string => {
  return typeof (globalThis as any).__zn_getProp === 'function'
    ? (globalThis as any).__zn_getProp(key) || ''
    : '';
};

const debugExpiresSec = parseInt(getProp('debug.zn.expires') || '0', 10);
const debugSchemaVer = parseInt(getProp('debug.zn.schema') || '1', 10);
const debugMigrate = getProp('debug.zn.migrate');

const migrations: Record<number, (old: any) => any> = {};
if (debugMigrate === 'v1') {
  migrations[1] = (old: any) => ({
    ...old,
    migratedV1ToV2: true,
  });
}

export const checkoutFlow = defineFlow<CheckoutData>({
  name: 'checkout',
  schemaVersion: debugSchemaVer > 0 ? debugSchemaVer : 1,
  expiresAfter: debugExpiresSec > 0
    ? { seconds: debugExpiresSec, sliding: false }
    : { minutes: 15, sliding: true },
  migrate: debugSchemaVer > 1 ? migrations : undefined,
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

        // S4c: Crash after /pay is received by backend, before response is committed to FlowStore
        if (typeof (globalThis as any).__zn_checkCrash === 'function') {
          (globalThis as any).__zn_checkCrash('S4c');
        }

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
