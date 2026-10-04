// Waitlist, invites, membership and feedback, against the Firestore emulator.
"use strict";
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const access = require("../src/access");

let db;
before(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Start the Firestore emulator first (npm run test:functions).");
  if (!getApps().length) initializeApp({ projectId: "demo-ptp" });
  db = getFirestore();
});
beforeEach(async () => {
  for (const c of ["waitlist", "invites", "members", "feedback", "rate", "appConfig"]) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
});
const form = (o = {}) => ({ email: "Pat@Example.com", name: "Pat", household: "5-6", store: "Walmart", phone: "iPhone", planning: "Mealime", diets: ["vegetarian", "bogus"], consent: true, survey: true, ...o });

test("a waitlist sign-up is saved once per email, with a place in line", async () => {
  const r = await access.joinWaitlist(db, form(), { ip: "1.2.3.4", FieldValue });
  assert.equal(r.position, 1);
  const again = await access.joinWaitlist(db, form({ store: "Aldi" }), { ip: "1.2.3.4", FieldValue });
  assert.equal(again.again, true);
  const all = await db.collection("waitlist").get();
  assert.equal(all.size, 1);
  const d = all.docs[0].data();
  assert.equal(d.email, "pat@example.com");
  assert.equal(d.store, "Aldi");
  assert.deepEqual(d.diets, ["vegetarian"]);
  assert.equal(d.status, "waiting");
});

test("the waitlist checks answers, consent, bots and repeat sign-ups from one address", async () => {
  await assert.rejects(access.joinWaitlist(db, form({ email: "nope" }), { ip: "9.9.9.9" }), /valid email/);
  await assert.rejects(access.joinWaitlist(db, form({ store: "Mars" }), { ip: "9.9.9.9" }), /every question/);
  await assert.rejects(access.joinWaitlist(db, form({ consent: false }), { ip: "9.9.9.9" }), /agree/);
  assert.deepEqual(await access.joinWaitlist(db, form({ website: "spam.com" }), { ip: "9.9.9.9" }), { ok: true });
  assert.equal((await db.collection("waitlist").get()).size, 0, "the bot sign-up wasn't stored");
  for (let i = 0; i < 10; i++) await access.joinWaitlist(db, form({ email: `p${i}@x.com` }), { ip: "5.5.5.5" });
  await assert.rejects(access.joinWaitlist(db, form({ email: "p11@x.com" }), { ip: "5.5.5.5" }), /Too many tries/);
});

test("an invite code lets a family in, up to its limit", async () => {
  const [code] = await access.createInvites(db, { count: 1, maxUses: 2, wave: "alpha" });
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await access.redeemInvite(db, { uid: "u1", email: "a@x.com", code: code.toLowerCase() })).already, false);
  assert.equal((await access.redeemInvite(db, { uid: "u1", code })).already, true, "same person again is fine");
  await access.redeemInvite(db, { uid: "u2", code: code.replace("-", " ") });
  await assert.rejects(access.redeemInvite(db, { uid: "u3", code }), /used up/);
  assert.ok(await access.isMember(db, "u2"));
  assert.ok(!(await access.isMember(db, "u3")));
});

test("bad, expired and turned-off codes are refused", async () => {
  await assert.rejects(access.redeemInvite(db, { uid: null, code: "ABCD-EFGH" }), /Sign in first/);
  await assert.rejects(access.redeemInvite(db, { uid: "u1", code: "123" }), /look like/);
  await assert.rejects(access.redeemInvite(db, { uid: "u1", code: "ZZZZ-ZZZZ" }), /isn't valid/);
  const [old] = await access.createInvites(db, { days: 1, now: new Date("2026-01-01") });
  await assert.rejects(access.redeemInvite(db, { uid: "u1", code: old }), /expired/);
  const [off] = await access.createInvites(db, {});
  await db.doc(`invites/${access.normCode(off)}`).set({ disabled: true }, { merge: true });
  await assert.rejects(access.redeemInvite(db, { uid: "u1", code: off }), /turned off/);
});

test("invite-only blocks AI for people who aren't in yet", async () => {
  await access.requireAccess(db, "anyone"); // open by default
  await db.doc("appConfig/access").set({ inviteOnly: true });
  await assert.rejects(access.requireAccess(db, "u9"), e => e.code === "permission-denied");
  const [code] = await access.createInvites(db, {});
  await access.redeemInvite(db, { uid: "u9", code });
  await access.requireAccess(db, "u9");
});

test("inviting from the waitlist gives each person a code and marks them invited", async () => {
  await access.joinWaitlist(db, form({ email: "a@x.com", name: "Ann" }), { ip: "1.1.1.1" });
  await access.joinWaitlist(db, form({ email: "b@x.com", name: "Ben" }), { ip: "1.1.1.1" });
  const ids = (await db.collection("waitlist").get()).docs.map(d => d.id);
  const out = await access.inviteFromWaitlist(db, { ids, maxUses: 4, wave: "beta1" });
  assert.equal(out.length, 2);
  assert.notEqual(out[0].code, out[1].code);
  const again = await access.inviteFromWaitlist(db, { ids: [ids[0]] });
  assert.equal(again[0].code, out.find(o => o.id === ids[0]).code, "re-inviting keeps the same code");
  const inv = await db.doc(`invites/${access.normCode(out[0].code)}`).get();
  assert.equal(inv.get("maxUses"), 4);
});

test("feedback is saved with its context and rate-limited", async () => {
  await assert.rejects(access.sendFeedback(db, { text: "" }, { uid: "u1" }), /few words/);
  const r = await access.sendFeedback(db, { kind: "bug", text: "The fill button did nothing", context: { version: "0.9", screen: "plan", width: 390 } }, { uid: "u1", email: "a@x.com" });
  const d = (await db.doc(`feedback/${r.id}`).get()).data();
  assert.equal(d.kind, "bug");
  assert.equal(d.context.screen, "plan");
  assert.equal(d.status, "new");
  const ov = await access.adminOverview(db);
  assert.equal(ov.feedback.length, 1);
  assert.equal(typeof ov.feedback[0].created, "string");
});
