/* ─── LLM Helper Module ─────────────────────────────────────────────────────
 * Calls a hosted Cloudflare Worker proxy that holds the Anthropic API key
 * as a secret. No key on the browser, no key required from users.
 *
 * If you need to redeploy the proxy or move it to a different host, just
 * update LLM_ENDPOINT below.
 * ──────────────────────────────────────────────────────────────────────── */

const LLM_ENDPOINT = 'https://goat-cricket-ai.YOUR-SUBDOMAIN.workers.dev';
const LLM_CACHE_KEY = 'goat-llm-cache';
const LLM_MODEL = 'claude-haiku-4-5';
const LLM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function _hashKey(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

function _loadCache() {
  try { return JSON.parse(localStorage.getItem(LLM_CACHE_KEY) || '{}'); }
  catch { return {}; }
}

function _saveCache(c) {
  try { localStorage.setItem(LLM_CACHE_KEY, JSON.stringify(c)); }
  catch { /* localStorage full, ignore */ }
}

function clearLLMCache() {
  localStorage.removeItem(LLM_CACHE_KEY);
}

function _getCached(hash) {
  const cache = _loadCache();
  const entry = cache[hash];
  if (!entry) return null;
  if (Date.now() - entry.t > LLM_CACHE_TTL_MS) {
    delete cache[hash];
    _saveCache(cache);
    return null;
  }
  return entry.v;
}

function _setCached(hash, value) {
  const cache = _loadCache();
  cache[hash] = { t: Date.now(), v: value };
  const keys = Object.keys(cache);
  if (keys.length > 100) {
    keys.sort((a, b) => cache[a].t - cache[b].t);
    for (let i = 0; i < keys.length - 100; i++) delete cache[keys[i]];
  }
  _saveCache(cache);
}

async function askLLM({ system, user, cacheKey, maxTokens = 600 }) {
  const hash = _hashKey((cacheKey || '') + '|' + system + '|' + user);
  const cached = _getCached(hash);
  if (cached) return cached;

  let res;
  try {
    res = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) {
    throw new Error('NETWORK_ERROR');
  }

  if (res.status === 429) throw new Error('RATE_LIMITED');
  if (res.status === 403) throw new Error('FORBIDDEN');

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    throw new Error(`AI_ERROR_${res.status}: ${detail}`);
  }

  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  _setCached(hash, text);
  return text;
}

/* ─── Context builders ──────────────────────────────────────────────────── */

function describeTuneParams(p, format) {
  const lines = [];
  const defaults = (typeof FORMAT_DEFAULTS !== 'undefined' && FORMAT_DEFAULTS[format])
    || (typeof TUNE_DEFAULTS_BASE !== 'undefined' ? TUNE_DEFAULTS_BASE : {});

  function note(key, label) {
    if (p[key] === undefined) return;
    const def = defaults[key];
    const cur = p[key];
    const diff = def !== undefined ? cur - def : 0;
    let suffix = '';
    if (def !== undefined && Math.abs(diff) > 0.05) {
      suffix = diff > 0 ? ' (raised above default)' : ' (lowered below default)';
    }
    lines.push(`- ${label}: ${typeof cur === 'number' ? cur.toFixed(2) : cur}${suffix}`);
  }

  note('batLongevity', 'Batting longevity weight');
  note('bowlLongevity', 'Bowling longevity weight');
  note('batPitch', 'Batting pitch-difficulty adjustment');
  note('bowlPitch', 'Bowling pitch-difficulty adjustment');
  note('alpha', 'Not-out correction (alpha)');
  note('batAvgW', 'Batting average weight');
  note('srWeight', 'Strike-rate weight');
  note('bowlSrWeight', 'Bowling strike-rate vs economy balance');
  note('bowlAvgW', 'Bowling average weight');
  note('wpiWeight', 'Wickets-per-innings weight');

  return lines.join('\n');
}

function summarizePlayer(p) {
  if (!p) return 'unknown';
  const parts = [
    `${p.name} (${p.country})`,
    `bat rating ${p.bat_rating || 0}`,
    `bowl rating ${p.bowl_rating || 0}`,
  ];
  if (p.bat_rank) parts.push(`bat rank #${p.bat_rank}`);
  if (p.bowl_rank) parts.push(`bowl rank #${p.bowl_rank}`);
  if (p.matches) parts.push(`${p.matches} matches`);
  if (p.career_bat_avg) parts.push(`bat avg ${p.career_bat_avg}`);
  if (p.career_bowl_avg) parts.push(`bowl avg ${p.career_bowl_avg}`);
  if (p.career_bat_sr) parts.push(`bat SR ${p.career_bat_sr}`);
  if (p.career_bowl_sr) parts.push(`bowl SR ${p.career_bowl_sr}`);
  if (p.career_wpi) parts.push(`wickets/innings ${p.career_wpi}`);
  if (p.bat_inns) parts.push(`${p.bat_inns} batting innings`);
  if (p.bowl_inns) parts.push(`${p.bowl_inns} bowling innings`);
  return parts.join(', ');
}

function formatRankingsContext(format) {
  const fmt = { tests: 'Test', odis: 'ODI', t20is: 'T20I', ipl: 'IPL' }[format] || 'Test';
  return `Format: ${fmt}\nThese rankings come from a transparent statistical model. ` +
    `Bat and bowl ratings are z-scored against the median player in each format, ` +
    `centered around 500, with 1000+ being all-time great. Higher = better.`;
}

const SYSTEM_PROMPT_BASE = `You are an expert cricket analyst embedded in the GOAT Cricket Rankings site, a tool that lets users tune the weighting of cricket statistics to produce their own GOAT rankings.

Rules:
- Be concise (2-5 sentences typically, longer only when warranted).
- Cite specific numbers from the data provided. Never speculate beyond it.
- When user tune parameters have been changed from defaults, acknowledge how this shifts the picture.
- Avoid platitudes. Get straight to the substance.
- Don't hedge excessively. State conclusions with evidence.
- Use plain language. No academic jargon.`;
