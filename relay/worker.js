// Weigh-in relay: reads your EufyLife scale history and hands it to the app (and to Claude).
//
// Runs as a Cloudflare Worker. Nothing personal lives in this file: your Eufy login and the
// relay key are Worker secrets, set in the Cloudflare dashboard (Settings > Variables and Secrets):
//   EUFY_EMAIL     your EufyLife email
//   EUFY_PASSWORD  your EufyLife password (accounts made with Google or Apple sign-in need one set first)
//   RELAY_KEY      any long random string; the app and the Claude connector send it to prove it's you
// Optional plain variables:
//   EUFY_PROFILE   the scale profile's name, e.g. "David", when several people share the scale
//   TIMEZONE       defaults to Europe/London; used to turn readings into local dates and times
//
// Routes
//   GET  /weighins?since=YYYY-MM-DD     Authorization: Bearer <RELAY_KEY>  -> { entries:[{date,time,kg,fat}] }
//   POST /mcp/<RELAY_KEY>               a small MCP server, for adding as a custom connector in Claude
//
// Uses the EufyLife app's own (undocumented) cloud API, as worked out by the community projects
// m4ary/eufylife-api-hacs and MatthewHallCom/eufylife-mcp. It may break if Eufy changes it.

const API = "https://api.eufylife.com";
const APP_ORIGIN = "https://diddlydurph.github.io";
const LOGIN_HEADERS = {
  Accept: "*/*", "Accept-Language": "en-GB,en;q=0.9", "User-Agent": "EufyLife-iOS-3.3.7",
  Category: "Health", Language: "en", Timezone: "UTC", Country: "GB", "Content-Type": "application/json",
};
const TOKEN_CACHE = "https://relay.internal/eufy-token";

// ── Eufy cloud ────────────────────────────────────────────────────────────────
async function login(env) {
  const res = await fetch(`${API}/v1/user/v2/email/login`, {
    method: "POST", headers: LOGIN_HEADERS,
    body: JSON.stringify({ client_id: "eufy-app", client_secret: "8FHf22gaTKu7MZXqz5zytw", email: env.EUFY_EMAIL, password: env.EUFY_PASSWORD }),
  });
  const d = await res.json().catch(() => ({}));
  if (d.res_code !== 1) throw new Error(`Eufy login failed: ${d.message || res.status}`);
  return {
    token: d.access_token, uid: d.user_id, exp: Math.floor(Date.now() / 1000) + (d.expires_in || 0),
    customers: (d.customers || []).map(c => ({ id: c.id, name: c.name })),
  };
}
// The token lasts about 30 days; keep it in this data centre's cache so we don't log in on every call
async function session(env, fresh) {
  const cache = caches.default;
  if (!fresh) {
    const hit = await cache.match(TOKEN_CACHE);
    if (hit) { const s = await hit.json(); if (s.exp - Date.now() / 1000 > 3600) return s; }
  }
  const s = await login(env);
  const ttl = Math.max(60, Math.min(s.exp - Math.floor(Date.now() / 1000) - 3600, 20 * 86400));
  await cache.put(TOKEN_CACHE, new Response(JSON.stringify(s), { headers: { "Cache-Control": `max-age=${ttl}` } }));
  return s;
}
async function deviceData(env, after) {
  for (const fresh of [false, true]) {
    const s = await session(env, fresh);
    const res = await fetch(`${API}/v1/device/data${after ? `?after=${after}` : ""}`, {
      headers: { Accept: "*/*", Uid: s.uid, Token: s.token, "User-Agent": "Eufylife-iOS-3.3.7-281", "Accept-Language": "en-GB,en;q=0.9" },
    });
    const d = await res.json().catch(() => ({}));
    if (d.res_code === 1) return { records: d.data || [], customers: s.customers };
    if (fresh) throw new Error(`Eufy data failed: ${d.message || res.status}`);
  }
}

// ── Readings as the app wants them ────────────────────────────────────────────
function localParts(sec, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(sec * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
async function weighIns(env, since) {
  const tz = env.TIMEZONE || "Europe/London";
  const after = since ? Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) - 86400 : 0;
  const { records, customers } = await deviceData(env, after > 0 ? after : 0);
  let ids = null;
  if (env.EUFY_PROFILE) {
    const want = env.EUFY_PROFILE.trim().toLowerCase();
    ids = new Set(customers.filter(c => String(c.name || "").trim().toLowerCase() === want).map(c => c.id));
  }
  const out = [];
  for (const r of records) {
    if (ids && ids.size && !ids.has(r.customer_id)) continue;
    const sd = r.scale_data || {}, kg = sd.weight ? sd.weight / 10 : 0;
    if (!(kg > 25 && kg < 350)) continue;
    const t = localParts(r.create_time, tz);
    if (since && t.date < since) continue;
    out.push({ ...t, kg: Math.round(kg * 100) / 100, fat: sd.body_fat || null });
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const cors = origin => ({
  "Access-Control-Allow-Origin": origin === APP_ORIGIN || /^http:\/\/localhost(:\d+)?$/.test(origin || "") ? origin : APP_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400", Vary: "Origin",
});
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
function sameKey(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0;
}

// ── MCP (JSON-RPC over HTTP, no streaming needed) ─────────────────────────────
const TOOLS = [{
  name: "get_weigh_ins",
  description: "Weigh-ins from the EufyLife smart scale: one row per reading with local date, time, weight in kg and body fat %. Also returns the latest reading and 7-day averages for this week and last week.",
  inputSchema: { type: "object", properties: {
    since: { type: "string", description: "YYYY-MM-DD; default 28 days ago" },
  } },
  annotations: { readOnlyHint: true },
}];
function summary(rows) {
  const day = new Map(); rows.forEach(r => { if (r.time < "12:00" && !day.has(r.date)) day.set(r.date, r.kg); });
  const days = [...day.entries()].sort();
  const avg = (from, to) => { const xs = days.filter(([d]) => d > from && d <= to).map(([, v]) => v); return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 100) / 100 : null; };
  const iso = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return { latest: rows[rows.length - 1] || null, avg7_kg: avg(iso(7), iso(0)), prev_avg7_kg: avg(iso(14), iso(7)),
    note: "Averages use the first reading before noon each day." };
}
async function mcp(req, env) {
  const msg = await req.json().catch(() => null);
  if (!msg || msg.jsonrpc !== "2.0") return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const reply = result => json({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "weigh-in-relay", version: "1.0.0" } });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      if (msg.params?.name !== "get_weigh_ins") return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool" } });
      try {
        const since = /^\d{4}-\d{2}-\d{2}$/.test(msg.params?.arguments?.since || "") ? msg.params.arguments.since
          : new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
        const rows = await weighIns(env, since);
        return reply({ content: [{ type: "text", text: JSON.stringify({ since, ...summary(rows), readings: rows }) }] });
      } catch (e) { return reply({ content: [{ type: "text", text: String(e.message || e) }], isError: true }); }
    }
    default: return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("Origin");
    if (!env.RELAY_KEY || !env.EUFY_EMAIL || !env.EUFY_PASSWORD) return json({ error: "Relay not set up: add EUFY_EMAIL, EUFY_PASSWORD and RELAY_KEY as secrets." }, 500);

    if (url.pathname.startsWith("/mcp/")) {
      if (!sameKey(url.pathname.slice(5).replace(/\/$/, ""), env.RELAY_KEY)) return json({ error: "Not found" }, 404);
      if (req.method !== "POST") return json({ error: "Use POST" }, 405, { Allow: "POST" });
      return mcp(req, env);
    }

    if (url.pathname === "/weighins") {
      const h = cors(origin);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      const key = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!sameKey(key, env.RELAY_KEY)) return json({ error: "Wrong relay key" }, 401, h);
      const since = url.searchParams.get("since");
      if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return json({ error: "since must be YYYY-MM-DD" }, 400, h);
      try { return json({ entries: await weighIns(env, since) }, 200, h); }
      catch (e) { return json({ error: String(e.message || e) }, 502, h); }
    }
    return json({ ok: true, service: "weigh-in relay" });
  },
};
