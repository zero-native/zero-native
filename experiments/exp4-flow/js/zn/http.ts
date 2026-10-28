/**
 * zero-native: HTTP fetch client backed by native bridge or Bun fallback
 */

let nextReqId = 1;
const pendingRequests = new Map<number, { resolve: (res: HttpResponse) => void; reject: (err: any) => void }>();

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  json: () => Promise<any>;
}

export function http(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResponse> {
  const method = options.method || 'GET';
  const headersJson = JSON.stringify(options.headers || {});
  const bodyJson = options.body || '';

  return new Promise((resolve, reject) => {
    const id = nextReqId++;
    pendingRequests.set(id, { resolve, reject });

    if (typeof (globalThis as any).__zn_http === 'function') {
      (globalThis as any).__zn_http(id, method, url, headersJson, bodyJson);
    } else {
      // In Bun / test runner: use native fetch
      fetch(url, {
        method,
        headers: options.headers,
        body: options.body,
      })
        .then(async (res) => {
          const txt = await res.text();
          resolve({
            status: res.status,
            ok: res.ok,
            text: async () => txt,
            json: async () => JSON.parse(txt),
          });
        })
        .catch(reject);
    }
  });
}

(globalThis as any).__zn_httpResponse = (reqId: number, status: number, body: string, error: string) => {
  const pending = pendingRequests.get(reqId);
  if (!pending) return;
  pendingRequests.delete(reqId);

  if (error && status === 0) {
    pending.reject(new Error(error));
  } else {
    pending.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
      json: async () => JSON.parse(body),
    });
  }
};
