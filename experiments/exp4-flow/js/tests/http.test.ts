import { describe, it, expect } from 'bun:test';
import { http } from '../zn/http';

describe('HTTP Client against Mock Backend', () => {
  it('calls POST /transactions/pay successfully', async () => {
    const res = await http('http://localhost:8787/transactions/pay', {
      method: 'POST',
      body: JSON.stringify({ entered_amount: 50000, counter: 'Counter 1' }),
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ztc).toMatch(/^ztc_exp4_/);
    expect(data.upi_link).toContain('zntest@upi');
  });

  it('calls GET /stats and verifies call counts', async () => {
    const res = await http('http://localhost:8787/stats');
    expect(res.ok).toBe(true);
    const stats = await res.json();
    expect(stats.payCallCount).toBeGreaterThanOrEqual(1);
  });
});
