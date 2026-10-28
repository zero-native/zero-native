import { describe, it, expect, beforeEach } from 'bun:test';
import { checkoutFlow } from '../flows/checkoutFlow';
import { http } from '../zn/http';

describe('Checkout Flow End-to-End State Machine', () => {
  beforeEach(async () => {
    await http('http://localhost:8787/reset', { method: 'POST' });
  });

  it('runs complete payment cycle from Amount -> Pay -> Launch -> Verify -> Cancelled', async () => {
    const flow = checkoutFlow.start({ amountPaise: 45500 });
    expect(flow.step).toBe('enteringAmount');

    // 1. User taps Pay Now
    await flow.dispatch('pay', { amountPaise: 45500, pkg: 'com.phonepe.app', name: 'PhonePe' });
    expect(flow.step).toBe('paying');

    // Effect 'postPay' has completed and recorded in effects
    const payEffect = flow.state.effects['postPay'];
    expect(payEffect.status).toBe('done');
    expect(payEffect.result.ztc).toBeDefined();

    // 2. Pay response moves flow to launchingUpi
    await flow.dispatch('payDone', payEffect.result);
    expect(flow.step).toBe('launchingUpi');

    const upiEffect = flow.state.effects['launchUpi'];
    expect(upiEffect.status).toBe('done');

    // 3. User cancels in PhonePe (resultCode = 0)
    await flow.dispatch('upiResult', { resultCode: 0 });
    expect(flow.step).toBe('verifying');

    const verifyEffect = flow.state.effects['verify'];
    expect(verifyEffect.status).toBe('done');
    expect(verifyEffect.result.parsedStatus).toBe('CANCELLED');

    // 4. Move to cancelled terminal step
    await flow.dispatch('verifyDone', verifyEffect.result);
    expect(flow.step).toBe('cancelled');

    // 5. Audit stats on mock backend: exactly 1 /pay and 1 /verify
    const statsRes = await http('http://localhost:8787/stats');
    const stats = await statsRes.json();
    expect(stats.payCallCount).toBe(1);
    expect(stats.verifyCallCount).toBe(1);
  });
});
