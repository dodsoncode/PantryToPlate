// Pantry to Plate → Kroger, as a Cloudflare Worker.
//
// Keeps your Kroger client secret off the website. Routes:
//   GET  /login?return=<app url>   → sends the shopper to Kroger to sign in
//   GET  /callback                 → Kroger sends them back here; returns tokens to the app
//   POST /refresh {refresh_token}  → new access token
//   GET  /locations?zip=32578      → nearby Kroger-family stores
//   GET  /products?term=salsa&locationId=…  → product matches (UPC, size, price)
//   POST /cart {access_token, items:[{upc, quantity}], modality}  → adds to the shopper's cart
//
// Setup (Cloudflare → Workers & Pages → Create → Worker → paste this file → Deploy):
//   1. Register an app at https://developer.kroger.com (Manage → Applications → Create).
//      Scopes: product.compact and cart.basic:write.
//      Redirect URI: https://<your-worker>.workers.dev/callback
//   2. Worker → Settings → Variables and Secrets:
//        KROGER_CLIENT_ID      (variable)
//        KROGER_CLIENT_SECRET  (secret)
//   3. Put the worker's address in firebase-config.js as KROGER_ENDPOINT.

const ALLOWED_ORIGINS = ["https://dodsoncode.github.io"];
const API = "https://api.kroger.com";
let appToken = null, appTokenExp = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) return json({ error: "The worker is missing KROGER_CLIENT_ID or KROGER_CLIENT_SECRET" }, 500);

    const basic = "Basic " + btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
    const redirectUri = `${url.origin}/callback`;
    const token = async params => {
      const r = await fetch(`${API}/v1/connect/oauth2/token`, {
        method: "POST",
        headers: { "Authorization": basic, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error_description || j.error || `Kroger sign-in error ${r.status}`);
      return j;
    };
    const appAuth = async () => {
      if (appToken && Date.now() < appTokenExp) return appToken;
      const t = await token({ grant_type: "client_credentials", scope: "product.compact" });
      appToken = t.access_token; appTokenExp = Date.now() + (t.expires_in - 60) * 1000;
      return appToken;
    };
    const allowedReturn = r => ALLOWED_ORIGINS.some(o => r.startsWith(o + "/"));

    try {
      // 1. Start sign-in
      if (url.pathname === "/login") {
        const ret = url.searchParams.get("return") || "";
        if (!allowedReturn(ret)) return new Response("Bad return address", { status: 400 });
        const auth = new URL(`${API}/v1/connect/oauth2/authorize`);
        auth.search = new URLSearchParams({
          scope: "cart.basic:write product.compact", response_type: "code",
          client_id: env.KROGER_CLIENT_ID, redirect_uri: redirectUri, state: btoa(ret),
        });
        return Response.redirect(auth.toString(), 302);
      }
      // 2. Kroger redirects back with ?code=
      if (url.pathname === "/callback") {
        let ret = ALLOWED_ORIGINS[0] + "/";
        try { const r = atob(url.searchParams.get("state") || ""); if (allowedReturn(r)) ret = r; } catch {}
        const back = ret.split("#")[0];
        const code = url.searchParams.get("code");
        if (!code) return Response.redirect(back + "#krogererror=" + encodeURIComponent(url.searchParams.get("error") || "cancelled"), 302);
        const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
        const payload = btoa(JSON.stringify({ a: t.access_token, r: t.refresh_token, e: Date.now() + t.expires_in * 1000 }))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        return Response.redirect(back + "#kroger=" + payload, 302);
      }
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "This site isn't allowed to use this worker" }, 403);

      if (url.pathname === "/refresh" && request.method === "POST") {
        const { refresh_token } = await request.json();
        const t = await token({ grant_type: "refresh_token", refresh_token });
        return json({ a: t.access_token, r: t.refresh_token || refresh_token, e: Date.now() + t.expires_in * 1000 });
      }
      if (url.pathname === "/locations") {
        const zip = (url.searchParams.get("zip") || "").replace(/\D/g, "").slice(0, 5);
        const r = await fetch(`${API}/v1/locations?filter.zipCode.near=${zip}&filter.radiusInMiles=50&filter.limit=8`,
          { headers: { Authorization: `Bearer ${await appAuth()}`, Accept: "application/json" } });
        const j = await r.json();
        return json({ stores: (j.data || []).map(s => ({
          id: s.locationId, name: s.name, chain: s.chain,
          address: [s.address?.addressLine1, s.address?.city].filter(Boolean).join(", "),
        })) });
      }
      if (url.pathname === "/products") {
        const p = new URLSearchParams({ "filter.term": (url.searchParams.get("term") || "").slice(0, 80), "filter.limit": "6" });
        const loc = url.searchParams.get("locationId"); if (loc) p.set("filter.locationId", loc);
        const r = await fetch(`${API}/v1/products?${p}`, { headers: { Authorization: `Bearer ${await appAuth()}`, Accept: "application/json" } });
        const j = await r.json();
        return json({ products: (j.data || []).map(x => ({
          upc: x.upc, id: x.productId, title: x.description, brand: x.brand,
          size: x.items?.[0]?.size || "", price: x.items?.[0]?.price?.promo || x.items?.[0]?.price?.regular || null,
        })).filter(x => x.upc) });
      }
      if (url.pathname === "/cart" && request.method === "POST") {
        const { access_token, items, modality } = await request.json();
        const list = (items || []).slice(0, 100).map(i => ({
          upc: String(i.upc), quantity: Math.min(Math.max(parseInt(i.quantity) || 1, 1), 50),
          modality: modality === "DELIVERY" ? "DELIVERY" : "PICKUP",
        }));
        const r = await fetch(`${API}/v1/cart/add`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ items: list }),
        });
        if (r.status === 401) return json({ error: "expired" }, 401);
        if (!r.ok) return json({ error: `Kroger cart error ${r.status}` }, 502);
        return json({ ok: true, added: list.length });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};
