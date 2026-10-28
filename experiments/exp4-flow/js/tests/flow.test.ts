import { describe, it, expect, beforeEach } from 'bun:test';
import { defineFlow, effect, setFlowStorageAdapter, FlowState, FlowStorageAdapter } from '../zn/flow';

describe('@flow State Machine & Write-Ahead Recovery Engine', () => {
  let mockStorage: Record<string, FlowState> = {};

  const testAdapter: FlowStorageAdapter = {
    save(state) {
      mockStorage[state.name] = JSON.parse(JSON.stringify(state));
    },
    load(name) {
      return mockStorage[name] ? JSON.parse(JSON.stringify(mockStorage[name])) : null;
    },
    delete(name) {
      delete mockStorage[name];
    },
  };

  beforeEach(() => {
    mockStorage = {};
    setFlowStorageAdapter(testAdapter);
  });

  it('rejects definition of "once" or "keyed" effects without reconcile step', () => {
    expect(() => {
      defineFlow({
        name: 'badFlow',
        schemaVersion: 1,
        expiresAfter: { minutes: 15 },
        initial: 'step1',
        data: {},
        steps: {
          step1: {
            enter: effect('badEff', { kind: 'once' } as any, async () => {}),
          },
        },
      });
    }).toThrow(/MUST declare a 'reconcile' step/);
  });

  it('enforces Write-Ahead persistence before executing effect actions', async () => {
    let storageAtActionTime: FlowState | null = null;

    const testFlow = defineFlow({
      name: 'checkout',
      schemaVersion: 1,
      expiresAfter: { minutes: 15 },
      initial: 'start',
      data: { amount: 500 },
      steps: {
        start: {
          on: {
            next: (d, _, f) => f.go('paying'),
          },
        },
        paying: {
          enter: effect('initiatePay', { kind: 'once', reconcile: 'verifying' }, async (d) => {
            // Check that at the moment action runs, storage ALREADY recorded 'started'
            storageAtActionTime = testAdapter.load('checkout');
            return { ztc: 'ztc_123', upiLink: 'upi://pay?pa=test@upi' };
          }),
        },
        verifying: {},
      },
    });

    const flow = testFlow.start();
    expect(flow.step).toBe('start');
    expect(mockStorage['checkout'].step).toBe('start');

    await flow.dispatch('next');

    // Verify Write-Ahead snapshot
    expect(storageAtActionTime).not.toBeNull();
    expect(storageAtActionTime!.step).toBe('paying');
    expect(storageAtActionTime!.effects['initiatePay'].status).toBe('started');

    // Verify final state
    const saved = testAdapter.load('checkout')!;
    expect(saved.effects['initiatePay'].status).toBe('done');
    expect(saved.effects['initiatePay'].result.ztc).toBe('ztc_123');
  });

  it('RESTORE RULE: "once" effect (UPI launch) never re-launches automatically on cold restore', () => {
    let upiLaunchCallCount = 0;

    const checkoutFlow = defineFlow({
      name: 'checkout',
      schemaVersion: 1,
      expiresAfter: { minutes: 15 },
      initial: 'entering',
      data: { ztc: 'ztc_999' },
      steps: {
        entering: {},
        launchingUpi: {
          enter: effect('launchUpi', { kind: 'once', reconcile: 'verifying' }, async () => {
            upiLaunchCallCount++;
          }),
        },
        verifying: {},
      },
    });

    // Simulate process killed while in UPI app (effect was 'started' but never completed in JS)
    mockStorage['checkout'] = {
      flowId: 'flow_1',
      name: 'checkout',
      schemaVersion: 1,
      step: 'launchingUpi',
      data: { ztc: 'ztc_999' },
      updatedAt: Date.now(),
      expiresAt: Date.now() + 900000,
      effects: {
        launchUpi: {
          id: 'launchUpi',
          kind: 'once',
          status: 'started',
          at: Date.now(),
          reconcile: 'verifying',
        },
      },
    };

    // Cold restore
    const outcome = checkoutFlow.restore(mockStorage['checkout']);
    expect(outcome.status).toBe('active');
    expect(outcome.flow!.step).toBe('verifying'); // Forced to reconcile step!
    expect(upiLaunchCallCount).toBe(0); // Zero duplicate launches!
  });

  it('RESTORE RULE: "keyed" effect preserves exact idempotency key on restore', () => {
    const paymentFlow = defineFlow({
      name: 'payFlow',
      schemaVersion: 1,
      expiresAfter: { minutes: 15 },
      initial: 'paying',
      data: { amount: 100 },
      steps: {
        paying: {
          enter: effect('postPayment', { kind: 'keyed', reconcile: 'verifying' }, async () => {}),
        },
        verifying: {},
      },
    });

    const originalKey = 'flow_test_keyed_123';
    mockStorage['payFlow'] = {
      flowId: 'flow_test',
      name: 'payFlow',
      schemaVersion: 1,
      step: 'paying',
      data: { amount: 100 },
      updatedAt: Date.now(),
      expiresAt: Date.now() + 900000,
      effects: {
        postPayment: {
          id: 'postPayment',
          kind: 'keyed',
          status: 'started',
          key: originalKey,
          at: Date.now(),
          reconcile: 'verifying',
        },
      },
    };

    const outcome = paymentFlow.restore(mockStorage['payFlow']);
    expect(outcome.status).toBe('active');
    expect(outcome.flow!.state.effects['postPayment'].key).toBe(originalKey);
  });

  it('RESTORE RULE: Native pre-cached result is attached to in-flight "once" effect', () => {
    const checkoutFlow = defineFlow({
      name: 'checkout',
      schemaVersion: 1,
      expiresAfter: { minutes: 15 },
      initial: 'launchingUpi',
      data: { ztc: 'ztc_123' },
      steps: {
        launchingUpi: {
          enter: effect('launchUpi', { kind: 'once', reconcile: 'verifying' }, async () => {}),
        },
        verifying: {},
      },
    });

    mockStorage['checkout'] = {
      flowId: 'flow_1',
      name: 'checkout',
      schemaVersion: 1,
      step: 'launchingUpi',
      data: { ztc: 'ztc_123' },
      updatedAt: Date.now(),
      expiresAt: Date.now() + 900000,
      effects: {
        launchUpi: {
          id: 'launchUpi',
          kind: 'once',
          status: 'started',
          at: Date.now(),
          reconcile: 'verifying',
        },
      },
    };

    const nativeResult = { resultCode: -1, status: 'SUCCESS', approvalRefNo: '123456' };
    const outcome = checkoutFlow.restore(mockStorage['checkout'], nativeResult);

    expect(outcome.status).toBe('active');
    expect(outcome.flow!.state.effects['launchUpi'].status).toBe('done');
    expect(outcome.flow!.state.effects['launchUpi'].result).toEqual(nativeResult);
  });

  it('EXPIRY RULE: expired flow with in-flight effects opens in "verifying", otherwise drops', () => {
    const flowDef = defineFlow({
      name: 'checkout',
      schemaVersion: 1,
      expiresAfter: { minutes: 15 },
      initial: 'entering',
      data: {},
      steps: { entering: {}, verifying: {} },
    });

    // 1. Expired with NO unsafe in-flight effect -> Drop
    const pastTime = Date.now() - 10000;
    const expiredSafeState: FlowState = {
      flowId: 'f1',
      name: 'checkout',
      schemaVersion: 1,
      step: 'entering',
      data: {},
      updatedAt: pastTime - 1000,
      expiresAt: pastTime,
      effects: {},
    };

    const outcome1 = flowDef.restore(expiredSafeState);
    expect(outcome1.status).toBe('dropped');

    // 2. Expired WITH in-flight "once" effect -> Open in reconcile
    const expiredUnsafeState: FlowState = {
      ...expiredSafeState,
      effects: {
        launchUpi: {
          id: 'launchUpi',
          kind: 'once',
          status: 'started',
          at: pastTime - 500,
          reconcile: 'verifying',
        },
      },
    };

    const outcome2 = flowDef.restore(expiredUnsafeState);
    expect(outcome2.status).toBe('reconcile');
    expect(outcome2.reconcileStep).toBe('verifying');
  });

  it('MIGRATION RULE: migrates data schema from v1 to v2 on restore', () => {
    const migratingFlow = defineFlow({
      name: 'checkout',
      schemaVersion: 2,
      expiresAfter: { minutes: 15 },
      initial: 'entering',
      data: { amountPaise: 0 },
      steps: { entering: {} },
      migrate: {
        1: (old: any) => ({
          amountPaise: Math.round(old.amountRupees * 100),
        }),
      },
    });

    const v1State: FlowState = {
      flowId: 'f_v1',
      name: 'checkout',
      schemaVersion: 1,
      step: 'entering',
      data: { amountRupees: 50 },
      updatedAt: Date.now(),
      expiresAt: Date.now() + 900000,
      effects: {},
    };

    const outcome = migratingFlow.restore(v1State);
    expect(outcome.status).toBe('active');
    expect(outcome.flow!.state.schemaVersion).toBe(2);
    expect(outcome.flow!.state.data.amountPaise).toBe(5000);
  });
});
