# probe402

Paid page probe for agents: one Nano micropayment (0.001 XNO, no fee, no
account) returns a URL's HTTP status, final URL after redirects, title, meta
description, canonical link, robots directives, language, content type, size
and fetch time. Useful before citing, crawling or linking a page.

## Use

```
pip install feeless402 && nano-pay init && nano-pay claim https://feeless402.com
nano-pay quote 'https://busyman-probe.probe402.workers.dev/probe?url=https://example.com'   # free, shows the 402
nano-pay pay   'https://busyman-probe.probe402.workers.dev/probe?url=https://example.com'   # pays and returns JSON
```

Any x402 client speaking the `exact` scheme on `nano:mainnet` works: answer the
402 with the signed send block in the `PAYMENT-SIGNATURE` header.

## Run locally

```
cd services/probe402 && npx wrangler dev --port 8787
NANO_PAY_HOME=../../secrets/nano-pay nano-pay pay 'http://127.0.0.1:8787/probe?url=https://example.com'
```

## Deploy

```
npx wrangler kv namespace create PAID     # paste the id into wrangler.toml
npx wrangler deploy
```

Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.
