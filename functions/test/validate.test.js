// Input checks: what reaches the AI, and what is refused before it.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const v = require("../src/validate");

const jpeg = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]).toString("base64");

test("pantry scan accepts up to 6 small photos", () => {
  const r = v.scan({ images: [jpeg(1000), jpeg(2000)], hint: "Fridge", vocab: ["milk"] });
  assert.equal(r.images.length, 2);
  assert.equal(r.images[0].mimeType, "image/jpeg");
});
test("pantry scan refuses too many, too large, or non-image photos", () => {
  assert.throws(() => v.scan({ images: Array(7).fill(jpeg(10)) }), /6 photos or fewer/);
  assert.throws(() => v.scan({ images: [jpeg(1.6 * 1024 * 1024)] }), /too large/);
  assert.throws(() => v.scan({ images: [Buffer.from("hello world, not an image").toString("base64")] }), /JPEG, PNG or WebP/);
  assert.throws(() => v.scan({ images: [] }), /at least one photo/);
  assert.throws(() => v.scan({ images: [jpeg(10)], hint: "Garage" }), /Unknown storage/);
  assert.throws(() => v.scan({ images: Array(5).fill(jpeg(1.4 * 1024 * 1024)) }), /too large together/);
});
test("recipe import takes one of link, pasted text or photos", () => {
  assert.equal(v.importRecipe({ url: "https://www.tasteofhome.com/recipes/x/" }).url, "https://www.tasteofhome.com/recipes/x/");
  assert.ok(v.importRecipe({ pasted: "x".repeat(100) }).pasted);
  assert.equal(v.importRecipe({ images: [jpeg(10)] }).images.length, 1);
  assert.throws(() => v.importRecipe({}), /Add a link/);
  assert.throws(() => v.importRecipe({ url: "ftp://x" }), /doesn't look right/);
  assert.throws(() => v.importRecipe({ url: "http://localhost:8080/x.y" }), /can't be read/);
  assert.throws(() => v.importRecipe({ pasted: "x".repeat(20001) }), /too long/);
  assert.throws(() => v.importRecipe({ pasted: "x".repeat(100), images: [jpeg(10)] }), /not both/);
});
test("suggestions need a known meal and short lists", () => {
  assert.equal(v.suggest({ meal: "dinner", avoid: ["peanuts"] }).meal, "dinner");
  assert.throws(() => v.suggest({ meal: "snack" }), /Unknown meal/);
  assert.throws(() => v.suggest({ meal: "dinner", note: "x".repeat(201) }), /too long/);
  assert.throws(() => v.suggest({ meal: "dinner", pantry: Array(201).fill("x") }), /too many/);
});
test("store-link requests are plain ingredient names", () => {
  assert.deepEqual(v.productRequests({ items: [{ name: "Diced Tomatoes", section: "Pantry" }] }), [{ name: "diced tomatoes", section: "Pantry" }]);
  assert.throws(() => v.productRequests({ items: [{ name: "<script>" }] }), /aren't allowed/);
  assert.throws(() => v.productRequests({ items: Array(26).fill({ name: "x" }) }), /25 names/);
});
