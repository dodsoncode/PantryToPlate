// Pantry to Plate → Instacart, as a Cloudflare Worker.
//
// The app sends this worker its store list; the worker calls Instacart's
// "Create shopping list page" API with your secret key and returns the link.
// The key never reaches the browser.
//
// Setup (Cloudflare dashboard → Workers & Pages → Create → Worker):
//   1. Paste this file as the worker code and Deploy.
//   2. Settings → Variables and Secrets → add a Secret named INSTACART_API_KEY
//      with your key from https://dashboard.instacart.com.
//   3. Optional: add a variable INSTACART_URL =
//      https://connect.dev.instacart.tools/idp/v1/products/products_link
//      while you only have a Development key. Without it, production is used.
//   4. Put the worker's address in firebase-config.js as INSTACART_ENDPOINT.

const ALLOWED_ORIGINS = ["https://dodsoncode.github.io"];
const PROD_URL = "https://connect.instacart.com/idp/v1/products/products_link";
const LINKBACK = "https://dodsoncode.github.io/PantryToPlate/";
const UNITS = new Set(["each", "pound", "ounce", "cup", "tablespoon", "teaspoon"]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);
    if (!allowed) return json({ error: "This site isn't allowed to use this worker" }, 403);
    if (!env.INSTACART_API_KEY) return json({ error: "The worker has no INSTACART_API_KEY secret yet" }, 500);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 150)
      .map(i => ({
        name: String(i.name || "").trim().slice(0, 100),
        quantity: Math.min(Math.max(Number(i.quantity) || 1, 0.01), 100),
        unit: UNITS.has(i.unit) ? i.unit : "each",
      }))
      .filter(i => i.name);
    if (!items.length) return json({ error: "The list is empty" }, 400);

    const res = await fetch(env.INSTACART_URL || PROD_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INSTACART_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        title: String(body.title || "Feed the Nest groceries").slice(0, 100),
        link_type: "shopping_list",
        expires_in: 30,
        line_items: items,
        landing_page_configuration: { partner_linkback_url: LINKBACK },
      }),
    });

    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!res.ok || !data.products_link_url) {
      return json({ error: data.error?.message || data.message || `Instacart error ${res.status}` }, 502);
    }
    return json({ products_link_url: data.products_link_url });
  },
};
