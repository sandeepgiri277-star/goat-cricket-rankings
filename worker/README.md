# GOAT Cricket AI Proxy

A Cloudflare Worker that proxies requests from the frontend to the Anthropic API. Keeps the API key off the browser so AI features work for all users without anyone needing to bring their own key.

## One-time setup (~5 minutes)

### 1. Install Wrangler (Cloudflare's CLI) and log in

```bash
cd worker
npm install
npx wrangler login
```

This opens a browser to authenticate with Cloudflare. Free account is fine.

### 2. Add your Anthropic API key as a secret

Get a key at [console.anthropic.com](https://console.anthropic.com) (any tier works; Haiku is very cheap).

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Paste the key when prompted. It's stored encrypted in Cloudflare and never appears in your code or logs.

### 3. (Optional) Enable per-IP rate limiting via KV

By default the worker forwards every valid request. To add a daily per-IP limit (60 requests/IP/day):

```bash
npx wrangler kv:namespace create RATE_LIMIT
```

Copy the `id` from the output. Open `wrangler.toml`, uncomment the `[[kv_namespaces]]` block, and paste the id.

### 4. Deploy

```bash
npx wrangler deploy
```

Wrangler will print a URL like `https://goat-cricket-ai.your-subdomain.workers.dev`. **Copy this URL.**

### 5. Wire it into the frontend

Open `docs/llm.js` and set:

```js
const LLM_ENDPOINT = 'https://goat-cricket-ai.your-subdomain.workers.dev';
```

Commit and push. AI features are now live for everyone.

## Costs

- **Cloudflare Workers**: free tier allows 100,000 requests/day. You will not exceed this unless the site goes viral.
- **Anthropic Claude Haiku 4.5**: ~$0.001–0.005 per question. With the built-in 60 req/IP/day cap, worst case per abuser is ~$0.30/day.
- **Recommendation**: set a monthly spend limit in your Anthropic console. $20/month is plenty for thousands of legit users.

## Monitoring

```bash
npx wrangler tail
```

Streams logs in real-time. Useful while testing.

## Tightening security later

- Add Cloudflare Turnstile (invisible CAPTCHA) for an extra abuse layer
- Switch the rate limit to per-IP-per-hour for stricter control
- Add a domain check via the `Referer` header in addition to `Origin`
- Move to a paid Workers plan ($5/mo) for higher CPU limits if needed
