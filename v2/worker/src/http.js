// ── HTTP / CORS / Auth helpers ────────────────────────────────────────────────

let _origin = 'https://arnarsr.github.io';

export function setOrigin(o) { _origin = o; }

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': _origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

export function requireAuth(request, env) {
  if (!env.API_TOKEN) return null; // opt-in — if no token configured, allow all
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (token !== env.API_TOKEN) return json({ error: 'Unauthorized' }, 401);
  return null;
}

/** Retry fn on network failure or 429/5xx, with exponential back-off. */
export async function withRetry(fn, maxAttempts = 2, delayMs = 1000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}
