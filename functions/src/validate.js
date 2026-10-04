// Input checks for every AI request. Anything that fails is rejected before the AI is called,
// and counts as a strike against the account (see guard.strike).
"use strict";

class BadInput extends Error {
  constructor(message) { super(message); this.name = "BadInput"; }
}

const LIMITS = {
  maxPhotos: 6,
  maxPhotoBytes: 1.5 * 1024 * 1024,      // per photo, after decoding
  maxTotalPhotoBytes: 6 * 1024 * 1024,   // all photos together (callable requests cap at 10 MB)
  maxPastedChars: 20000,
};
const LOCS = ["Fridge", "Freezer", "Pantry", "Spices"];
const MEALS = ["breakfast", "lunch", "dinner"];

const isObj = x => x && typeof x === "object" && !Array.isArray(x);
function str(x, name, max, { required = false } = {}) {
  if (x === undefined || x === null || x === "") {
    if (required) throw new BadInput(`${name} is missing.`);
    return "";
  }
  if (typeof x !== "string") throw new BadInput(`${name} must be text.`);
  if (x.length > max) throw new BadInput(`${name} is too long (limit ${max} characters).`);
  return x;
}
function strList(x, name, maxItems, maxLen) {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) throw new BadInput(`${name} must be a list.`);
  if (x.length > maxItems) throw new BadInput(`${name} has too many entries (limit ${maxItems}).`);
  return x.map((v, i) => str(v, `${name} ${i + 1}`, maxLen)).filter(Boolean);
}
// Photos arrive as base64 JPEG/PNG/WebP without the data: prefix.
function photos(x, { required }) {
  if (x === undefined || x === null) {
    if (required) throw new BadInput("Add at least one photo.");
    return [];
  }
  if (!Array.isArray(x)) throw new BadInput("Photos must be a list.");
  if (required && !x.length) throw new BadInput("Add at least one photo.");
  if (x.length > LIMITS.maxPhotos) throw new BadInput(`Use ${LIMITS.maxPhotos} photos or fewer.`);
  let total = 0;
  const out = x.map((p, i) => {
    if (typeof p !== "string" || !/^[A-Za-z0-9+/=\r\n]+$/.test(p)) throw new BadInput(`Photo ${i + 1} isn't a valid image.`);
    const bytes = Math.floor(p.replace(/[\r\n=]/g, "").length * 3 / 4);
    if (bytes > LIMITS.maxPhotoBytes) throw new BadInput(`Photo ${i + 1} is too large (limit 1.5 MB).`);
    total += bytes;
    const head = Buffer.from(p.slice(0, 16), "base64");
    const jpeg = head[0] === 0xff && head[1] === 0xd8;
    const png = head[0] === 0x89 && head[1] === 0x50;
    const webp = head.slice(0, 4).toString() === "RIFF";
    if (!jpeg && !png && !webp) throw new BadInput(`Photo ${i + 1} isn't a JPEG, PNG or WebP image.`);
    return { data: p, mimeType: jpeg ? "image/jpeg" : png ? "image/png" : "image/webp" };
  });
  if (total > LIMITS.maxTotalPhotoBytes) throw new BadInput("The photos are too large together. Use fewer or smaller photos.");
  return out;
}

function scan(d) {
  if (!isObj(d)) throw new BadInput("Request is empty.");
  const hint = str(d.hint, "Location", 20);
  if (hint && !LOCS.includes(hint)) throw new BadInput("Unknown storage location.");
  return { images: photos(d.images, { required: true }), hint, vocab: strList(d.vocab, "Food names", 400, 60) };
}

function importRecipe(d) {
  if (!isObj(d)) throw new BadInput("Request is empty.");
  const url = str(d.url, "Link", 2000).trim();
  const pasted = str(d.pasted, "Pasted recipe", LIMITS.maxPastedChars);
  const images = photos(d.images, { required: false });
  if (!url && !pasted && !images.length) throw new BadInput("Add a link, pasted text or a photo.");
  if (images.length && pasted) throw new BadInput("Send either photos or pasted text, not both.");
  if (url && !/^https?:\/\/[^\s/$.?#][^\s]*\.[^\s]+$/i.test(url)) throw new BadInput("That link doesn't look right. It should start with https://");
  if (url && /^https?:\/\/(localhost|127\.|10\.|192\.168\.|169\.254\.|\[|0\.)/i.test(url)) throw new BadInput("That link can't be read.");
  if (pasted && pasted.trim().length < 40) throw new BadInput("Paste the ingredients and directions first.");
  return { url, pasted, images };
}

function suggest(d) {
  if (!isObj(d)) throw new BadInput("Request is empty.");
  const meal = str(d.meal, "Meal", 20, { required: true });
  if (!MEALS.includes(meal)) throw new BadInput("Unknown meal.");
  return {
    meal,
    diet: str(d.diet, "Diet", 120),
    avoid: strList(d.avoid, "Foods to avoid", 60, 60),
    note: str(d.note, "Note", 200),
    pantry: strList(d.pantry, "Kitchen items", 200, 60),
    skip: strList(d.skip, "Recipes to skip", 250, 120),
  };
}

// Ingredient names that still need a store link (no AI involved, but still rate-limited).
function productRequests(d) {
  if (!isObj(d) || !Array.isArray(d.items)) throw new BadInput("Request is empty.");
  if (d.items.length > 25) throw new BadInput("Send 25 names or fewer at a time.");
  return d.items.map((it, i) => {
    if (!isObj(it)) throw new BadInput(`Item ${i + 1} is not valid.`);
    const name = str(it.name, `Item ${i + 1}`, 70, { required: true }).toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9 &'(),./%-]*$/.test(name)) throw new BadInput(`Item ${i + 1} has characters that aren't allowed.`);
    return { name, section: str(it.section, `Item ${i + 1} section`, 30) };
  });
}

module.exports = { BadInput, LIMITS, scan, importRecipe, suggest, productRequests };
