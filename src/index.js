// busyman-probe: paid page probe behind an x402 "exact" quote on nano:mainnet.
//
// GET /            free: this description as JSON
// GET /health      free: {"ok":true}
// GET /probe?url=  paid: fetch the URL and return status, final URL, title,
//                  description, canonical, robots, lang, content type, bytes, ms
//
// Payment: the client answers the 402 with a signed Nano send state block in the
// PAYMENT-SIGNATURE (or X-PAYMENT) header, base64 JSON, payload.block (the
// feeless402 / x402nano dialect). The block is broadcast to a public node, which
// enforces signature and work; we then confirm on the ledger that it is a send
// of PRICE_RAW to PAY_TO and serve it at most REPLAY_MAX times (KV).

const RPCS = [
  "https://rpc.nano.to",
  "https://node.somenano.com/proxy",
  "https://rainstorm.city/api",
  "https://nanoslo.0x.no/proxy",
];
const REPLAY_MAX = 3;
const REPLAY_WINDOW_S = 15 * 60;
const ALPHABET = "13456789abcdefghijkmnopqrstuwxyz";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// nano_ address -> 64-hex public key (base32, 4 padding bits, 5-byte checksum).
function addressToPk(addr) {
  const s = addr.replace(/^nano_|^xrb_/, "");
  if (s.length !== 60) throw new Error("bad address length");
  let bits = "";
  for (const c of s.slice(0, 52)) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("bad address char");
    bits += v.toString(2).padStart(5, "0");
  }
  bits = bits.slice(4); // 260 bits -> 256
  let hex = "";
  for (let i = 0; i < 256; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

async function rpc(payload) {
  let last = "";
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      if (data && data.error) {
        const e = String(data.error).toLowerCase().trim();
        if (e === "block not found" || e === "account not found" || e.startsWith("old block")) return data;
        last = `${url}: ${data.error}`;
        continue;
      }
      if (r.status >= 400) { last = `${url}: HTTP ${r.status}`; continue; }
      return data;
    } catch (e) { last = `${url}: ${e}`; }
  }
  throw new Error(`all RPC nodes failed: ${last}`);
}

// x402 v2 resource-server manifest, the shape crawled by x402 directories.
function manifest(env, origin) {
  return {
    x402Version: 2, kind: "resource-server", seller: "busyman-probe", name: "busyman-probe",
    description: "Paid page probe: status, final URL, title, description, canonical, robots, lang, content type, size and timing of any URL. 0.001 XNO per call, no account, no fee.",
    resources: [{
      url: `${origin}/probe`, method: "GET",
      description: "Probe a URL. Accepts ?url=<absolute http(s) url>. Returns payment receipt and result JSON.",
      accepts: [{ scheme: "exact", network: "nano:mainnet", asset: "XNO", amount: env.PRICE_RAW, payTo: env.PAY_TO }],
    }],
    free: [{ url: `${origin}/health`, method: "GET", description: "Liveness check, no payment." }],
    docs: env.DOCS_URL, updated: "2026-09-25",
  };
}

function quote(env, resource) {
  const body = {
    x402Version: 2,
    error: "Payment required: 0.001 XNO per probe on nano:mainnet",
    resource: { url: resource, mimeType: "application/json" },
    accepts: [{
      scheme: "exact", network: "nano:mainnet", asset: "XNO",
      amount: env.PRICE_RAW, payTo: env.PAY_TO, maxTimeoutSeconds: 60,
    }],
    extensions: {
      "rail-hint": { info: {
        cheapest: "nano:mainnet",
        docs: env.DOCS_URL,
        bootstrap: "pip install feeless402 && nano-pay init && nano-pay claim https://feeless402.com",
        spec: "x402 exact scheme on nano:mainnet",
      } },
    },
  };
  return json(body, 402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(body)) });
}

function extractBlock(request) {
  const hdr = request.headers.get("payment-signature") || request.headers.get("x-payment");
  if (!hdr) return null;
  try {
    const b = JSON.parse(atob(hdr)).payload.block;
    if (!b || b.type !== "state") throw new Error();
    return b;
  } catch { throw new Error("unparseable payment header"); }
}

// Broadcast, then confirm on the ledger. Returns {hash, payer, replay}.
async function settle(env, block) {
  const ourPk = addressToPk(env.PAY_TO);
  if (String(block.link).toUpperCase() !== ourPk) throw new Error("block.link does not pay this server");
  const proc = await rpc({ action: "process", json_block: "true", subtype: "send", block });
  let hash = proc.hash ? String(proc.hash).toUpperCase() : null;
  if (!hash) {
    // "Old block": the client re-presents a block already in the ledger. Find it.
    const hist = await rpc({ action: "account_history", account: block.account, count: "10", raw: "true" });
    const hit = (hist.history || []).find(h =>
      String(h.link || "").toUpperCase() === ourPk && String(h.balance) === String(block.balance)
      && String(h.previous || "").toUpperCase() === String(block.previous).toUpperCase());
    if (!hit) throw new Error(`payment not found on ledger (${proc.error || "no hash"})`);
    hash = String(hit.hash).toUpperCase();
  }
  let info = null;
  for (let i = 0; i < 16; i++) {
    info = await rpc({ action: "block_info", json_block: "true", hash });
    if (String(info.confirmed) === "true") break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!info || String(info.confirmed) !== "true") throw new Error("payment not confirmed in time");
  if (info.subtype !== "send") throw new Error("block is not a send");
  if (String(info.amount) !== String(env.PRICE_RAW)) throw new Error(`amount ${info.amount} != required ${env.PRICE_RAW}`);
  if (String(info.contents.link).toUpperCase() !== ourPk) throw new Error("confirmed block does not pay this server");
  const ts = Number(info.local_timestamp || 0);
  const served = Number((await env.PAID.get(hash)) || 0);
  if (served > 0 && ts && Date.now() / 1000 - ts > REPLAY_WINDOW_S) throw new Error("payment already used");
  if (served >= REPLAY_MAX) throw new Error("payment already used");
  await env.PAID.put(hash, String(served + 1), { expirationTtl: 86400 });
  return { hash, payer: info.contents.account, replay: served > 0 };
}

function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i");
  const m = html.match(re) || html.match(re2);
  return m ? m[1].trim() : null;
}

function validateTarget(target) {
  let u;
  try { u = new URL(target); } catch { throw new Error("url is not a valid absolute URL"); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http and https");
  return u;
}

async function probe(target) {
  const u = validateTarget(target);
  const t0 = Date.now();
  const r = await fetch(u.toString(), {
    redirect: "follow",
    headers: { "user-agent": "busyman-probe/1.0 (+https://github.com/busyman-agent/probe402)", accept: "text/html,*/*" },
    signal: AbortSignal.timeout(15000),
  });
  const buf = await r.arrayBuffer();
  const ms = Date.now() - t0;
  const ctype = r.headers.get("content-type") || "";
  const out = { url: target, final_url: r.url, status: r.status, content_type: ctype, bytes: buf.byteLength, ms,
    last_modified: r.headers.get("last-modified"), x_robots_tag: r.headers.get("x-robots-tag") };
  if (/html|xml/.test(ctype)) {
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 512 * 1024));
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]+href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
    const lang = html.match(/<html[^>]+lang=["']([^"']*)["']/i);
    Object.assign(out, {
      title: title ? title[1].replace(/\s+/g, " ").trim() : null,
      description: meta(html, "description"),
      canonical: canon ? canon[1] : null,
      robots: meta(html, "robots"),
      og_title: meta(html, "og:title"),
      lang: lang ? lang[1] : null,
    });
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/.well-known/x402") return json(manifest(env, url.origin));  // discovery manifest for directories
    if (url.pathname === "/") return json({
      service: "busyman-probe",
      what: "Fetch a URL and return its status, final URL, title, description, canonical, robots, lang, content type, size and timing.",
      endpoint: `${url.origin}/probe?url=<absolute url>`,
      price: "0.001 XNO per call, x402 exact scheme on nano:mainnet, no account, no fee",
      pay: "nano-pay pay '" + url.origin + "/probe?url=https://example.com'",
      docs: env.DOCS_URL,
    });
    if (url.pathname !== "/probe") return json({ error: "not found" }, 404);
    const target = url.searchParams.get("url");
    if (!target) return json({ error: "missing url query parameter" }, 400);
    try { validateTarget(target); } catch (e) { return json({ error: e.message }, 400); }  // reject before quoting: never charge for a bad input
    let block;
    try { block = extractBlock(request); } catch (e) { return json({ error: `payment invalid: ${e.message}` }, 402); }
    if (!block) return quote(env, url.toString());
    let receipt;
    try { receipt = await settle(env, block); } catch (e) { return json({ error: `payment invalid: ${e.message}` }, 402); }
    let result;
    try { result = await probe(target); } catch (e) { result = { url: target, error: e.message }; }
    const resp = { success: true, hash: receipt.hash, confirmed: true, network: "nano:mainnet", replay: receipt.replay };
    return json({ payment: resp, result }, 200, { "PAYMENT-RESPONSE": btoa(JSON.stringify(resp)), "X-PAYMENT-RESPONSE": btoa(JSON.stringify(resp)) });
  },
};
