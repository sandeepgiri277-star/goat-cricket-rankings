/**
 * GOAT Cricket Rankings — AI proxy worker
 *
 * Two routing surfaces:
 *
 *   POST /                        → forwards to Anthropic Messages API
 *                                   (used by simple one-shot features:
 *                                   "Why this ranking?", "Compare", chat).
 *
 *   POST /agent/ask               → forwards to the Modal-hosted Cricket
 *   POST /agent/ask/stream        Analyst (LangGraph agent). SSE is
 *   POST /agent/ask/approve       streamed through unchanged.
 *
 * Defenses:
 *  - Origin allow-list (CORS)
 *  - Method restriction (POST only)
 *  - Per-IP rate limit (KV-backed, optional)
 *  - Output token cap on the direct Anthropic path
 *  - Request body cap on both paths
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
const MAX_INPUT_CHARS = 60000;

const RATE_LIMIT_DIRECT_PER_DAY = 60;
const RATE_LIMIT_AGENT_PER_DAY = 30;
const RATE_LIMIT_WINDOW_S = 86400;

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

async function checkRateLimit(env, ip, bucket, limit) {
  if (!env.RATE_LIMIT) return { ok: true, remaining: -1 };
  const key = `rl:${bucket}:${ip}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_S)}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (current >= limit) return { ok: false, remaining: 0 };
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_S + 60 });
  return { ok: true, remaining: limit - current - 1 };
}

async function handleDirectAnthropic(request, env, cors, ip) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server misconfigured: missing ANTHROPIC_API_KEY' }, 500, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, cors); }

  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Body must be object' }, 400, cors);
  if (!body.model || !ALLOWED_MODELS.has(body.model)) return jsonResponse({ error: 'Disallowed model' }, 400, cors);
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return jsonResponse({ error: 'messages required' }, 400, cors);

  if (JSON.stringify(body).length > MAX_INPUT_CHARS)
    return jsonResponse({ error: 'Request too large' }, 413, cors);

  if (!body.max_tokens || body.max_tokens > MAX_OUTPUT_TOKENS) body.max_tokens = MAX_OUTPUT_TOKENS;

  const rl = await checkRateLimit(env, ip, 'direct', RATE_LIMIT_DIRECT_PER_DAY);
  if (!rl.ok) return jsonResponse({ error: 'Rate limit reached for today.' }, 429, cors);

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

  const text = await upstream.text();
  const headers = { ...cors, 'content-type': 'application/json' };
  if (rl.remaining >= 0) headers['x-ratelimit-remaining'] = String(rl.remaining);
  return new Response(text, { status: upstream.status, headers });
}

async function handleAgent(request, env, cors, ip, subpath) {
  if (!env.AGENT_ENDPOINT) {
    return jsonResponse({ error: 'Server misconfigured: missing AGENT_ENDPOINT' }, 500, cors);
  }

  const rl = await checkRateLimit(env, ip, 'agent', RATE_LIMIT_AGENT_PER_DAY);
  if (!rl.ok) return jsonResponse({ error: 'Agent rate limit reached for today.' }, 429, cors);

  const url = `${env.AGENT_ENDPOINT.replace(/\/$/, '')}/ask${subpath}`;
  const body = await request.text();
  if (body.length > MAX_INPUT_CHARS) return jsonResponse({ error: 'Request too large' }, 413, cors);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch (e) {
    return jsonResponse({ error: 'Agent upstream fetch failed', detail: String(e) }, 502, cors);
  }

  // Pass through SSE responses untouched (stream).
  const isStream = subpath === '/stream';
  const headers = {
    ...cors,
    'content-type': isStream ? 'text/event-stream' : 'application/json',
    'cache-control': 'no-cache',
  };
  if (rl.remaining >= 0) headers['x-ratelimit-remaining'] = String(rl.remaining);

  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const cors = buildCorsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    if (!ALLOWED_ORIGINS.includes(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, cors);

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { pathname } = new URL(request.url);

    if (pathname === '/' || pathname === '') {
      return handleDirectAnthropic(request, env, cors, ip);
    }
    if (pathname === '/agent/ask') {
      return handleAgent(request, env, cors, ip, '');
    }
    if (pathname === '/agent/ask/stream') {
      return handleAgent(request, env, cors, ip, '/stream');
    }
    if (pathname === '/agent/ask/approve') {
      return handleAgent(request, env, cors, ip, '/approve');
    }
    return jsonResponse({ error: 'Unknown path' }, 404, cors);
  },
};
