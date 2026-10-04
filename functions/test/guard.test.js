// Limits, lockouts and the safety valve, against the Firestore emulator.
// Run with: npm run test:functions (from the repo root).
"use strict";
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const guard = require("../src/guard");

let db;
before(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Start the Firestore emulator first (npm run test:functions).");
  if (!require("firebase-admin/app").getApps().length) initializeApp({ projectId: "demo-ptp" });
  db = getFirestore();
});
beforeEach(async () => {
  for (const c of ["aiUsage", "aiLocks", "aiGlobal", "aiConfig", "pantryToPlate", "households"]) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
  guard.resetConfigCache();
});
const NOW = new Date("2026-10-04T15:00:00Z"); // 10 am Central

test("sign-in is required", async () => {
  await assert.rejects(guard.begin(db, { uid: null, feature: "scan", now: NOW }), e => e.code === "unauthenticated");
});

test("a person gets 5 scans a day, then a clear message", async () => {
  for (let i = 0; i < 5; i++) {
    const t = await guard.begin(db, { uid: "alice", feature: "scan", now: NOW });
    assert.equal(t.left.person, 4 - i);
  }
  await assert.rejects(guard.begin(db, { uid: "alice", feature: "scan", now: NOW }),
    e => e.code === "resource-exhausted" && /all 5 pantry scans/.test(e.message) && /midnight/.test(e.message));
  // Other features and other people are counted separately.
  await guard.begin(db, { uid: "alice", feature: "import", now: NOW });
  await guard.begin(db, { uid: "bob", feature: "scan", now: NOW });
});

test("limits reset at midnight Central time", async () => {
  for (let i = 0; i < 5; i++) await guard.begin(db, { uid: "alice", feature: "scan", now: NOW });
  const lateSameDay = new Date("2026-10-05T04:30:00Z");   // 11:30 pm Central, still Oct 4
  await assert.rejects(guard.begin(db, { uid: "alice", feature: "scan", now: lateSameDay }), e => e.code === "resource-exhausted");
  const nextDay = new Date("2026-10-05T05:30:00Z");       // 12:30 am Central, Oct 5
  await guard.begin(db, { uid: "alice", feature: "scan", now: nextDay });
});

test("a household shares a cap of 10 scans, but only real members count", async () => {
  await db.doc("households/HOUSE12345").set({ members: ["alice", "bob"] });
  await db.doc("pantryToPlate/alice").set({ household: "HOUSE12345" });
  await db.doc("pantryToPlate/bob").set({ household: "HOUSE12345" });
  await db.doc("pantryToPlate/mallory").set({ household: "HOUSE12345" }); // claims it, isn't a member
  for (let i = 0; i < 5; i++) await guard.begin(db, { uid: "alice", feature: "scan", now: NOW });
  for (let i = 0; i < 5; i++) await guard.begin(db, { uid: "bob", feature: "scan", now: NOW });
  await db.doc("households/HOUSE12345").update({ members: ["alice", "bob", "carol"] });
  await db.doc("pantryToPlate/carol").set({ household: "HOUSE12345" });
  await assert.rejects(guard.begin(db, { uid: "carol", feature: "scan", now: NOW }), e => /household has used all 10/.test(e.message));
  const t = await guard.begin(db, { uid: "mallory", feature: "scan", now: NOW });
  assert.equal(t.household, null);
});

test("a failed AI call gives the use back", async () => {
  const t = await guard.begin(db, { uid: "alice", feature: "suggest", now: NOW });
  await guard.refund(db, t, null, FieldValue);
  const u = (await db.doc(`aiUsage/alice_2026-10-04`).get()).data();
  assert.equal(u.suggest, 0);
});

test("five bad requests in a day lock the account's AI for 24 hours", async () => {
  for (let i = 0; i < 4; i++) assert.equal(await guard.strike(db, { uid: "eve", reason: "oversized", now: NOW }), null);
  const until = await guard.strike(db, { uid: "eve", reason: "oversized", now: NOW });
  assert.equal(until.getTime(), NOW.getTime() + 24 * 3600e3);
  await assert.rejects(guard.begin(db, { uid: "eve", feature: "import", now: NOW }), e => e.code === "resource-exhausted" && /paused on this account/.test(e.message));
  await guard.begin(db, { uid: "eve", feature: "import", now: new Date(NOW.getTime() + 25 * 3600e3) });
});

test("old strikes expire", async () => {
  const old = new Date(NOW.getTime() - 30 * 3600e3);
  for (let i = 0; i < 4; i++) await guard.strike(db, { uid: "eve", reason: "x", now: old });
  assert.equal(await guard.strike(db, { uid: "eve", reason: "x", now: NOW }), null);
});

test("the safety valve pauses AI for everyone once the day's spend passes the budget", async () => {
  const t = await guard.begin(db, { uid: "alice", feature: "import", now: NOW });
  // 4 million input + 6 million output tokens at the default prices = $20.
  await guard.finish(db, t, { promptTokenCount: 4e6, candidatesTokenCount: 6e6 / 1 }, FieldValue);
  const g = (await db.doc("aiGlobal/2026-10-04").get()).data();
  assert.ok(g.spendUsd >= 20, `spend was ${g.spendUsd}`);
  await assert.rejects(guard.begin(db, { uid: "bob", feature: "scan", now: NOW }), e => e.code === "unavailable" && /today's limit for everyone/.test(e.message));
  // Store-link requests use no AI and keep working.
  await guard.begin(db, { uid: "bob", feature: "products", count: 3, now: NOW });
});

test("the off switch and new limits apply from aiConfig/main without redeploying", async () => {
  await db.doc("aiConfig/main").set({ paused: true });
  guard.resetConfigCache();
  await assert.rejects(guard.begin(db, { uid: "alice", feature: "scan", now: NOW }), e => e.code === "unavailable" && /paused/.test(e.message));
  await db.doc("aiConfig/main").set({ paused: false, limits: { scan: { person: 1 } } });
  guard.resetConfigCache();
  await guard.begin(db, { uid: "alice", feature: "scan", now: NOW });
  await assert.rejects(guard.begin(db, { uid: "alice", feature: "scan", now: NOW }), e => /all 1 pantry scans/.test(e.message));
  const cfg = await guard.config(db);
  assert.equal(cfg.limits.scan.household, 10, "unset values keep their defaults");
});
