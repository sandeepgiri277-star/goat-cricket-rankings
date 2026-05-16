/**
 * GOAT Cricket Rankings — AI proxy worker
 *
 * Forwards requests from the frontend to the Anthropic API,
 * injecting the API key (stored as a Cloudflare secret) so the
 * key never touches the browser.
 *
 * Defenses:
 *  - Origin allow-list (CORS)
 *  - Method restriction (POST only)
 *  - Request shape validation
 *  - Output token cap
 *  - Per-IP rate limit (KV-backed, optional)
 */

const ALLOWED_ORIGINS = [
  'https://sandeepgiri277-star.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:3000',
];

const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

const MAX_OUTPUT_TOKENS = 1000;
const MAX_INPUT_CHARS = 30000;

const RATE_LIMIT_PER_DAY = 60;      // requests per IP per day
const RATE_LIMIT_WINDOW_S = 86400;  // 24 hours

function buildCorsHeaders(origin) {
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  return {
    'access-control-allow-origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT) return { ok: true, remaining: -1 };
  const key = `rl:${ip}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_S)}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (current >= RATE_LIMIT_PER_DAY) {
    return { ok: false, remaining: 0 };
  }
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_S + 60 });
  return { ok: true, remaining: RATE_LIMIT_PER_DAY - current - 1 };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const cors = buildCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    }

    if (!ALLOWED_ORIGINS.includes(origin)) {
      return jsonResponse({ error: 'Forbidden origin' }, 403, cors);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'Server misconfigured: missing ANTHROPIC_API_KEY secret' }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, cors);
    }

    // Validate shape (Anthropic Messages API)
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Body must be an object' }, 400, cors);
    }
    if (!body.model || !ALLOWED_MODELS.has(body.model)) {
      return jsonResponse({ error: 'Disallowed model' }, 400, cors);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return jsonResponse({ error: 'messages must be a non-empty array' }, 400, cors);
    }

    // Size guard
    const approxSize = JSON.stringify(body).length;
    if (approxSize > MAX_INPUT_CHARS) {
      return jsonResponse({ error: 'Request too large' }, 413, cors);
    }

    // Cap max_tokens
    if (!body.max_tokens || body.max_tokens > MAX_OUTPUT_TOKENS) {
      body.max_tokens = MAX_OUTPUT_TOKENS;
    }

    // Rate limit (only if KV namespace is bound)
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const rl = await checkRateLimit(env, ip);
    if (!rl.ok) {
      return jsonResponse({ error: 'Rate limit reached for today. Try again in 24 hours.' }, 429, cors);
    }

    // Forward to Anthropic
    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return jsonResponse({ error: 'Upstream fetch failed', detail: String(e) }, 502, cors);
    }

    const respBody = await upstream.text();
    const respHeaders = { ...cors, 'content-type': 'application/json' };
    if (rl.remaining >= 0) respHeaders['x-ratelimit-remaining'] = String(rl.remaining);

    return new Response(respBody, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
