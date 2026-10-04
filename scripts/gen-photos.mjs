// Generates AI recipe photos to compare with the stock-photo picks in photos.json.
//
// Needs the dedicated Pantry to Plate Google Cloud project with billing on and the Vertex AI API enabled.
// Sign in once with:  gcloud auth application-default login
// Then, from the repo root:
//   node scripts/gen-photos.mjs --project YOUR-PROJECT-ID            (all recipes in photos.json, 2 tries each)
//   node scripts/gen-photos.mjs --project YOUR-PROJECT-ID --only chili --tries 3
//   node scripts/gen-photos.mjs --project YOUR-PROJECT-ID --model gemini-3.1-flash-image
//
// Pictures land in img/ai/<recipe>-<n>.<ext>, and photos.json records them under "ai".
// Every picture uses the same house style so the library looks like one set.
// Rough cost: about $0.07 per picture, so the 6 starter recipes at 2 tries each is about $0.85.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { GoogleGenAI } = require("@google/genai");

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const project = arg("project", process.env.GOOGLE_CLOUD_PROJECT);
const model = arg("model", "gemini-3.1-flash-image");
const tries = Math.max(1, Math.min(4, +arg("tries", 2)));
const only = arg("only", "");
if (!project) { console.error("Add --project YOUR-PROJECT-ID"); process.exit(1); }

export const STYLE = "Overhead food photograph, square 1:1. One serving on a plain white ceramic plate (or white bowl for soups, oats and chili) " +
  "centered on a light natural oak table. Soft natural window light from the left, gentle shadows, true-to-life colors, appetizing but realistic home cooking, " +
  "not overly styled. A folded linen napkin and a fork at the edge are fine. No text, no logos, no hands, no people, no brand packaging, no watermark.";

// What each dish should look like, so the picture matches the recipe rather than a generic version.
export const DISHES = {
  fajitas: "sheet-pan chicken fajitas: seared strips of seasoned chicken with sliced red, yellow and green bell peppers and onions, two warm flour tortillas, a lime wedge, a small dish of salsa",
  spaghetti: "spaghetti with a hearty ground-beef tomato meat sauce on top, a little grated parmesan and a basil leaf",
  chili: "black bean and sweet potato chili in a bowl: cubed sweet potato, black beans, tomatoes, topped with a spoon of sour cream, sliced green onion and a little shredded cheddar",
  overnightoats: "overnight oats in a bowl, creamy oats topped with sliced banana, fresh berries, a drizzle of honey and a sprinkle of chia seeds",
  turkeywraps: "two turkey club wraps cut in half on the diagonal showing sliced turkey, bacon, lettuce, tomato and a flour tortilla, with a few baby carrots on the side",
  salmon: "a honey garlic glazed salmon fillet with a shiny glaze, a scoop of white rice and steamed broccoli florets, sesame seeds on the salmon",
};

const ai = new GoogleGenAI({ vertexai: true, project, location: arg("location", "global") });
const prefs = JSON.parse(readFileSync("photos.json", "utf8"));
mkdirSync("img/ai", { recursive: true });

for (const [id, rec] of Object.entries(prefs.recipes)) {
  if (only && !only.split(",").includes(id)) continue;
  const dish = DISHES[id] || rec.name;
  const prompt = `${STYLE}\nThe dish: ${dish}.`;
  const files = [];
  for (let n = 1; n <= tries; n++) {
    try {
      const res = await ai.models.generateContent({
        model, contents: prompt,
        config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } },
      });
      const part = (res.candidates?.[0]?.content?.parts || []).find(p => p.inlineData);
      if (!part) { console.warn(`${id} #${n}: no picture came back`); continue; }
      const ext = (part.inlineData.mimeType || "image/png").includes("jpeg") ? "jpg" : "png";
      const file = `img/ai/${id}-${n}.${ext}`;
      writeFileSync(file, Buffer.from(part.inlineData.data, "base64"));
      files.push(file);
      console.log(`${id} #${n}: ${file}`);
    } catch (e) {
      console.error(`${id} #${n}: ${e.status || ""} ${e.message}`);
      if (e.status === 403) { console.error("403 usually means billing or the Vertex AI API isn't on for this project yet."); process.exit(1); }
    }
  }
  if (files.length) rec.ai = { files, pick: null, model, prompt, generated: new Date().toISOString().slice(0, 10) };
}
writeFileSync("photos.json", JSON.stringify(prefs, null, 2) + "\n");
console.log("Saved to photos.json. Next: compare with the stock picks and set each recipe's \"chosen\".");
