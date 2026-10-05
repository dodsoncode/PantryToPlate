// Checks AI recipe photos against the house rules, using a Gemini model that looks at each picture.
// Flags: wrong utensil (or a utensil on finger food), more than one utensil, a visible table edge,
// window or wall, and food that doesn't match the description.
//
//   node scripts/check-photos.mjs --project pantry-to-plate-f728c --firebase-login [--only a,b] [--files f1,f2]
// Checks each recipe's current pick (or the given files) and writes photo-check.json with any problems.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { GoogleGenAI } = require("@google/genai");

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes("--" + k);
const project = arg("project", process.env.GOOGLE_CLOUD_PROJECT);
const model = arg("model", "gemini-3.5-flash-lite");

const opts = { vertexai: true, project, location: "global", httpOptions: { timeout: 120000 } };
if (flag("firebase-login")) {
  const { OAuth2Client } = require("google-auth-library");
  const api = require("../node_modules/firebase-tools/lib/api.js");
  const tokens = JSON.parse(readFileSync(require("os").homedir() + "/.config/configstore/firebase-tools.json", "utf8")).tokens;
  const val = v => typeof v === "function" ? v() : v;
  const authClient = new OAuth2Client(val(api.clientId), val(api.clientSecret));
  authClient.setCredentials({ refresh_token: tokens.refresh_token });
  opts.googleAuthOptions = { authClient };
}
const ai = new GoogleGenAI(opts);

async function withRetry(fn) {
  for (let wait = 10; ; wait *= 2) {
    try { return await fn(); }
    catch (e) {
      if (wait > 160) throw e;
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
}

const prefs = JSON.parse(readFileSync("photos.json", "utf8"));
let jobs;
if (arg("files")) {
  jobs = arg("files").split(",").map(f => { const id = f.split("/").pop().replace(/-\d+\.\w+$/, ""); return { id, file: f }; });
} else {
  const ids = arg("only") ? arg("only").split(",") : Object.keys(prefs.recipes);
  jobs = ids.map(id => ({ id, file: prefs.recipes[id] && prefs.recipes[id].chosen === "ai" ? prefs.recipes[id].ai.pick : null })).filter(j => j.file);
}

const problems = {};
let n = 0;
for (const { id, file } of jobs) {
  const rec = prefs.recipes[id];
  const d = (rec && rec.ai && rec.ai.described) || {};
  const want = d.utensil === "none" ? "no utensils at all" : `exactly one utensil: ${d.utensil || "a fork"}`;
  const res = await withRetry(() => ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: file.endsWith(".png") ? "image/png" : "image/jpeg", data: readFileSync(file).toString("base64") } },
      { text: `This should be a close-up food photo of "${rec ? rec.name : id}": ${d.dish || ""}
Rules: ${want}; the plate or ${d.tall ? "jar, shot from a 45-degree angle" : "bowl, shot from directly above"}, nearly filling the frame; only a light oak tabletop around it, with no table edge, window, wall or floor visible.
List only clear rule breaks. Ignore small styling details.` },
    ] }],
    config: {
      thinkingConfig: { thinkingLevel: "low" },
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          utensils_seen: { type: "array", items: { type: "string", enum: ["fork", "spoon", "knife", "chopsticks"] } },
          table_edge_or_background: { type: "boolean" },
          wrong_food: { type: "string", description: "Empty if the food matches; else what's wrong, in a few words" },
        },
        required: ["utensils_seen", "table_edge_or_background", "wrong_food"],
      },
    },
  }));
  const v = JSON.parse(res.text);
  if (flag("verbose")) console.log(id, JSON.stringify(v));
  const issues = [];
  const seen = v.utensils_seen || [];
  if (d.utensil === "none" && seen.length) issues.push(`has a ${seen.join(" and ")} (should have none)`);
  else if (d.utensil && d.utensil !== "none" && (seen.length !== 1 || !d.utensil.includes(seen[0]))) issues.push(`utensils: ${seen.join(", ") || "none"} (should be ${d.utensil})`);
  if (v.table_edge_or_background) issues.push("table edge or background showing");
  if (v.wrong_food) issues.push(v.wrong_food);
  if (issues.length) { problems[id] = { file, issues }; console.log(`${id}: ${issues.join("; ")}`); }
  if (++n % 10 === 0) console.log(`  checked ${n}/${jobs.length}`);
}
writeFileSync("photo-check.json", JSON.stringify(problems, null, 2) + "\n");
console.log(`Checked ${n}; ${Object.keys(problems).length} with problems. Saved photo-check.json.`);
