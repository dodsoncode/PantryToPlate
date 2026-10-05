// Generates AI recipe photos to compare with the stock-photo picks in photos.json.
//
// Each picture is built from the recipe itself: a text model reads the recipe's ingredients, prep and
// directions and writes what the finished serving looks like (what it's served in, what's on top, and
// whether you eat it with a spoon or a fork). That description goes into one fixed house style, so the
// whole library looks like one set.
//
// Needs the Pantry to Plate Google Cloud project with billing on and the Vertex AI API enabled.
// Sign in once with `gcloud auth application-default login`, or set ACCESS_TOKEN to a short-lived token.
// From the repo root:
//   node scripts/gen-photos.mjs --project pantry-to-plate-f728c                 (recipes in photos.json, 2 each)
//   node scripts/gen-photos.mjs --project pantry-to-plate-f728c --only chili,salmon --tries 3
//   node scripts/gen-photos.mjs --project pantry-to-plate-f728c --only friedrice  (any recipe id; adds it)
//   node scripts/gen-photos.mjs --project pantry-to-plate-f728c --describe-only   (print descriptions, no pictures)
//   node scripts/gen-photos.mjs --project pantry-to-plate-f728c --all --missing --tries 1 --firebase-login
//                                    (one photo for every recipe still without one, using your `firebase login`)
//
// New pictures are added as img/ai/<recipe>-<n>.<ext> after any earlier ones, and listed in photos.json
// under "ai.files" along with the description used. Shrink them to 640px before committing.
// Rough cost: about $0.07 per picture plus a fraction of a cent per description.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { GoogleGenAI } = require("@google/genai");

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes("--" + k);
const project = arg("project", process.env.GOOGLE_CLOUD_PROJECT);
const imageModel = arg("model", "gemini-3.1-flash-image");
const textModel = arg("text-model", "gemini-3.5-flash-lite");
const tries = Math.max(1, Math.min(4, +arg("tries", 2)));
const only = arg("only", "");
if (!project) { console.error("Add --project YOUR-PROJECT-ID"); process.exit(1); }

// The house style. {utensil} becomes the utensil line below; the vessel and dish come from the recipe.
// Camera angle. Flat dishes are shot from directly above; tall ones (jars, glasses, parfaits) at 45 degrees
// so you can see both the layers up the side and the toppings.
const VIEW = {
  overhead: "Square 1:1 top-down (directly overhead) food photograph of a single serving. The plate or bowl is large in the frame, filling about 80 to 85 percent of the width.",
  angled: "Square 1:1 food photograph of a single serving, shot from a 45-degree angle (not from directly above and not straight from the side) so both the height and layers of the food and its top are visible. The jar, glass, burger or sandwich is large in the frame, filling most of its height, and stands upright the way it is served. Behind the food there is only more of the same oak tabletop, softly out of focus: never a window, window frame, curtain, wall or room.",
};
const UTENSIL = {
  "a spoon": "Exactly one utensil: a spoon, resting on a small folded light linen napkin tucked close beside the food, partly cropped by the edge of the frame. No other utensils, no knives, no chopsticks.",
  "a fork": "Exactly one utensil: a fork, resting on a small folded light linen napkin tucked close beside the food, partly cropped by the edge of the frame. No other utensils, no knives, no chopsticks.",
  "none": "This is finger food, eaten by hand. There are NO utensils anywhere in the picture: no fork, no spoon, no knife. The only thing beside the plate is a small folded light linen napkin, tucked close and partly cropped by the edge of the frame.",
};
export const STYLE = [
  "{view}",
  "Shot close: the dish nearly fills the frame. Only a thin strip of light natural-oak tabletop shows around the plate, napkin and utensil, with very little empty space. Do not show the edge of the table, a window, a wall, the floor or anything beyond the tabletop.",
  "No windows anywhere in the picture, not even a corner or reflection. Soft natural daylight from the left with gentle shadows, true-to-life colors, appetizing but realistic home cooking, not overly styled.",
  "Arrange the food naturally and casually, the way a person would plate it at home: slightly offset, not perfectly symmetrical or mirror-image.",
  "{utensil}",
  "Nothing else on the table: no drinks, no extra bowls or plates, no loose ingredients, no garnish that isn't in the description.",
  "No text, no logos, no hands, no people, no brand packaging, no watermark.",
].join(" ");

// ---------- recipes ----------
function loadRecipes() {
  const window = {};
  vm.runInNewContext(readFileSync("recipes.js", "utf8"), { window });
  const html = readFileSync("index.html", "utf8");
  const a = html.indexOf("const RECIPES=[");
  const b = html.indexOf("\n];", a);
  const builtIn = vm.runInNewContext(html.slice(a + "const RECIPES=".length, b + 2));
  const byId = {};
  for (const r of [...builtIn, ...(window.LIBRARY || [])]) byId[r.id] = r;
  return byId;
}

const ai = (() => {
  // A request that hangs is cut off after 150 seconds and retried (see withRetry).
  const opts = { vertexai: true, project, location: arg("location", "global"), httpOptions: { timeout: 150000 } };
  if (flag("firebase-login")) {
    // Reuse the Firebase CLI sign-in (firebase login). Refreshes itself, so long runs keep working.
    const { OAuth2Client } = require("google-auth-library");
    const api = require("../node_modules/firebase-tools/lib/api.js");
    const tokens = JSON.parse(readFileSync(require("os").homedir() + "/.config/configstore/firebase-tools.json", "utf8")).tokens;
    const val = v => typeof v === "function" ? v() : v;
    const authClient = new OAuth2Client(val(api.clientId), val(api.clientSecret));
    authClient.setCredentials({ refresh_token: tokens.refresh_token });
    opts.googleAuthOptions = { authClient };
  } else if (process.env.ACCESS_TOKEN) {
    const { OAuth2Client } = require("google-auth-library");
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: process.env.ACCESS_TOKEN });
    opts.googleAuthOptions = { authClient };
  }
  return new GoogleGenAI(opts);
})();

// New projects get a small per-minute allowance; on "429 busy" wait and try again.
async function withRetry(fn) {
  for (let wait = 20; ; wait *= 2) {
    try { return await fn(); }
    catch (e) {
      const stalled = !e.status && /abort|timed? ?out/i.test(String(e.message || e.name));
      const flaky = [500, 503, 504].includes(e.status);
      if ((e.status !== 429 && !stalled && !flaky) || wait > 160) throw e;
      console.log(stalled || flaky ? `  no answer (${e.status || "timeout"}), trying again in ${wait}s...` : `  busy, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
}

/** Reads the recipe and describes the finished single serving, so the picture matches what we cook. */
async function describe(r) {
  const recipe = [
    `Name: ${r.name}`,
    r.meal ? `Meal: ${r.meal}` : "",
    `Ingredients: ${(r.ing || []).map(i => i[2]).join(", ")}`,
    r.prep && r.prep.length ? `Prep: ${r.prep.join(" ")}` : "",
    `Directions: ${(r.steps || []).join(" ")}`,
  ].filter(Boolean).join("\n");
  const res = await withRetry(() => ai.models.generateContent({
    model: textModel,
    contents: `You describe how one serving of a home-cooked recipe looks when it's served, for a food photographer.

Rules:
- Follow the recipe's prep and directions for how it is served. If they say jars, it's in a glass jar; a bowl, a bowl; a sheet pan or skillet, then plated on a plate unless they say to serve from the pan.
- Show only foods in the ingredients or named in the directions. Toppings and sides only if the recipe has them. Don't add herbs, garnishes or sides the recipe doesn't have.
- Show the food as the directions finish it (sliced, rolled and halved, stirred, topped, etc.). Burgers and sandwiches are assembled and upright, never lying on their side; cut sandwiches show the filling at the cut edge, facing the camera.
- Utensil: "none" for food eaten by hand (wraps, sandwiches, burgers, tacos, quesadillas, burritos, pitas, pizza, muffins, bagels, toast eaten by hand, bars, cookies, finger snacks). "a spoon" for anything eaten with a spoon (soups, chili, stews, oatmeal, overnight oats, cereal, yogurt, smoothie bowls). Otherwise "a fork" (plated meals, salads, pasta, bowls of rice or grains, French toast, pancakes).
- Vessel: plain white ceramic for plates and bowls; clear glass for jars.

Recipe:
"""
${recipe}
"""`,
    config: {
      thinkingConfig: { thinkingLevel: "low" }, // a short description doesn't need long thinking, and long thinking was timing out
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          vessel: { type: "string", description: "What one serving is in or on, e.g. 'a clear glass jar', 'a white ceramic bowl', 'a white ceramic plate'" },
          utensil: { type: "string", enum: ["none", "a spoon", "a fork"] },
          tall: { type: "boolean", description: "true when the food is tall and its height and layers matter: served in a jar or glass (overnight oats, parfaits, smoothies, layered drinks), or any burger or sandwich (including subs, hoagies, sloppy joes, grilled cheese, breakfast sandwiches). False for wraps, pitas, tacos and quesadillas." },
          dish: { type: "string", description: "One or two sentences on what the serving looks like, using only the recipe's foods" },
        },
        required: ["vessel", "utensil", "tall", "dish"],
      },
    },
  }));
  return JSON.parse(res.text);
}

// ---------- run ----------
const recipes = loadRecipes();
const prefs = JSON.parse(readFileSync("photos.json", "utf8"));
// --all: every recipe in the app. --missing: skip recipes that already have an AI photo.
let ids = only ? only.split(",").map(s => s.trim()).filter(Boolean) : flag("all") ? Object.keys(recipes) : Object.keys(prefs.recipes);
if (flag("missing")) ids = ids.filter(id => !(prefs.recipes[id] && prefs.recipes[id].ai && prefs.recipes[id].ai.files.length));
mkdirSync("img/ai", { recursive: true });

for (const id of ids) {
  const r = recipes[id];
  if (!r) { console.warn(`${id}: no recipe with that id`); continue; }
  const rec = prefs.recipes[id] || (prefs.recipes[id] = { name: r.name, real: null, ai: null, chosen: null });
  let d;
  try { d = await describe(r); }
  catch (e) { console.error(`${id}: couldn't describe the recipe: ${e.status || ""} ${e.message}`); continue; }
  // photos.json "view" on a recipe ("angled" or "overhead") overrides the camera angle the recipe reading picked.
  // photos.json "fix" on a recipe: extra direction from a review, e.g. "the chicken should be the main thing you see".
  const fix = rec.fix ? `\nMake sure: ${rec.fix}` : "";
  const prompt = `${STYLE.replace("{view}", (rec.view ? rec.view === "angled" : d.tall) ? VIEW.angled : VIEW.overhead).replace("{utensil}", UTENSIL[d.utensil] || UTENSIL["a fork"])}\nServed in ${d.vessel}.\nThe dish: ${r.name}. ${d.dish}${fix}`;
  console.log(`${id}: ${d.vessel}, ${d.utensil}${d.tall ? ", 45°" : ""}. ${d.dish}`);
  if (flag("describe-only")) continue;

  const made = [];
  let n = 1;
  for (let t = 0; t < tries; t++) {
    while (["png", "jpg"].some(x => existsSync(`img/ai/${id}-${n}.${x}`))) n++;
    try {
      const res = await withRetry(() => ai.models.generateContent({
        model: imageModel, contents: prompt,
        config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } },
      }));
      const part = (res.candidates?.[0]?.content?.parts || []).find(p => p.inlineData);
      if (!part) { console.warn(`  #${n}: no picture came back`); n++; continue; }
      const ext = (part.inlineData.mimeType || "image/png").includes("jpeg") ? "jpg" : "png";
      const file = `img/ai/${id}-${n}.${ext}`;
      writeFileSync(file, Buffer.from(part.inlineData.data, "base64"));
      made.push(file);
      console.log(`  #${n}: ${file}`);
    } catch (e) {
      console.error(`  #${n}: ${e.status || ""} ${e.message}`);
      if (e.status === 403) { console.error("403 usually means billing or the Vertex AI API isn't on for this project yet."); process.exit(1); }
    }
  }
  if (made.length) {
    const prev = rec.ai || { files: [], pick: null };
    rec.ai = { ...prev, files: [...prev.files, ...made], model: imageModel, prompt, described: d, generated: new Date().toISOString().slice(0, 10) };
    writeFileSync("photos.json", JSON.stringify(prefs, null, 2) + "\n"); // save as we go, so a stopped run keeps what it made
  }
}
if (!flag("describe-only")) {
  writeFileSync("photos.json", JSON.stringify(prefs, null, 2) + "\n");
  console.log("Saved to photos.json. Compare, then set each recipe's \"chosen\" (and \"ai.pick\").");
}
