/**
 * ZeroBill Mock Backend for Experiment 4 (Bun HTTP Server on port 8787)
 * Implements GEMINI_BRIEF.md §7.3
 *
 * Endpoints:
 *  - POST /transactions/pay
 *  - POST /transactions/verify
 *  - POST /control
 *  - GET  /stats
 *  - POST /reset
 */

interface ServerState {
  payCallCount: number;
  verifyCallCount: number;
  payCallsBySession: Record<string, number>;
  requestLogs: Array<{
    timestamp: number;
    method: string;
    path: string;
    body: any;
    headers: Record<string, string>;
  }>;
  control: {
    status: 'SUCCESS' | 'CANCELLED' | 'FAILED' | 'PENDING';
    retry: boolean;
    retryDelayMs: number;
  };
}

const state: ServerState = {
  payCallCount: 0,
  verifyCallCount: 0,
  payCallsBySession: {},
  requestLogs: [],
  control: {
    status: 'CANCELLED',
    retry: false,
    retryDelayMs: 1000,
  },
};

const PORT = 8787;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });

    let body: any = null;
    if (method === 'POST') {
      try {
        body = await req.json();
      } catch {
        body = null;
      }
    }

    state.requestLogs.push({
      timestamp: Date.now(),
      method,
      path,
      body,
      headers,
    });

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': 'application/json',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. POST /transactions/pay
    if (method === 'POST' && path === '/transactions/pay') {
      const sessionId = body?.counter || body?.data || 'default_session';
      state.payCallCount++;
      state.payCallsBySession[sessionId] = (state.payCallsBySession[sessionId] || 0) + 1;

      const ztc = `ztc_exp4_${Date.now()}`;
      const amount = body?.entered_amount || 455;
      const fakeVpa = 'zntest@upi';
      const upiLink = `upi://pay?pa=${fakeVpa}&pn=ZN%20Test&am=${(amount / 100).toFixed(2)}&cu=INR&tn=zn-exp4`;

      const responsePayload = {
        ztc,
        total_amount: amount,
        pay_amount: amount,
        saved_amount: 50,
        pay_type: 'UPI_INTENT',
        upi_link: upiLink,
        order_id: `ord_${Date.now()}`,
        cancelsAt: Date.now() + 900000,
        transaction: {
          id: `txn_${Date.now()}`,
          amount,
          status: 'INITIATED',
        },
      };

      console.log(`[mock-backend] POST /transactions/pay -> ztc=${ztc}, count=${state.payCallCount}`);
      return new Response(JSON.stringify(responsePayload), { headers: corsHeaders });
    }

    // 2. POST /transactions/verify
    if (method === 'POST' && path === '/transactions/verify') {
      state.verifyCallCount++;
      const ztc = headers['_ztc'] || 'unknown_ztc';
      const successHeader = headers['_success'];
      const upiResponse = String(body?.upi_response || '');

      let outcomeStatus = state.control.status;

      // If client explicitly indicated failure or UPI response indicates failure, respect it
      if (successHeader === 'false') {
        if (upiResponse.includes('responseCode=U69') || upiResponse.includes('USER_DROPPED') || upiResponse.includes('RESULTCODE=0')) {
          outcomeStatus = 'CANCELLED';
        } else {
          outcomeStatus = 'FAILED';
        }
      } else if (upiResponse.includes('Status=FAILURE') || upiResponse.includes('STATUS=FAILURE')) {
        outcomeStatus = 'FAILED';
      }

      const responsePayload = {
        status: outcomeStatus,
        order_id: `ord_verify_${Date.now()}`,
        retry: state.control.retry,
        retry_delay: state.control.retryDelayMs,
        is_delayed: false,
        transaction: {
          id: `txn_${ztc}`,
          status: outcomeStatus,
        },
      };

      console.log(`[mock-backend] POST /transactions/verify -> outcomeStatus=${outcomeStatus}, count=${state.verifyCallCount}`);
      return new Response(JSON.stringify(responsePayload), { headers: corsHeaders });
    }

    // 3. POST /control
    if (method === 'POST' && path === '/control') {
      if (body?.status) state.control.status = body.status;
      if (body?.retry !== undefined) state.control.retry = body.retry;
      if (body?.retryDelayMs !== undefined) state.control.retryDelayMs = body.retryDelayMs;

      console.log(`[mock-backend] POST /control -> updated state:`, state.control);
      return new Response(JSON.stringify({ ok: true, control: state.control }), { headers: corsHeaders });
    }

    // 4. GET /stats
    if (method === 'GET' && path === '/stats') {
      return new Response(
        JSON.stringify({
          payCallCount: state.payCallCount,
          verifyCallCount: state.verifyCallCount,
          payCallsBySession: state.payCallsBySession,
          control: state.control,
          totalRequests: state.requestLogs.length,
          recentLogs: state.requestLogs.slice(-10),
        }),
        { headers: corsHeaders }
      );
    }

    // 5. POST /reset
    if (method === 'POST' && path === '/reset') {
      state.payCallCount = 0;
      state.verifyCallCount = 0;
      state.payCallsBySession = {};
      state.requestLogs = [];
      state.control = {
        status: 'CANCELLED',
        retry: false,
        retryDelayMs: 1000,
      };
      console.log(`[mock-backend] POST /reset -> server reset`);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Not found', path }), { status: 404, headers: corsHeaders });
  },
});

console.log(`[mock-backend] Bun server listening on http://localhost:${PORT}`);
