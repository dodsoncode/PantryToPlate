// Private test access: the waitlist, invite codes, member list and feedback.
//
// Firestore documents (server-only unless noted):
//   appConfig/access     { inviteOnly: true|false }   readable by the app, so it knows whether to show the invite screen
//   waitlist/{id}        one sign-up from the waitlist page, with its screener answers; id = hash of the email
//   invites/{CODE}       { maxUses, uses, wave, note, expires, createdBy, created }
//   members/{uid}        people let in; readable by that person only
//   feedback/{id}        what testers send from the app
//   rate/{key}_{day}     counters that slow down repeated sign-ups and feedback from one place
"use strict";

const crypto = require("node:crypto");

class AccessError extends Error {
  constructor(code, message) { super(message); this.name = "AccessError"; this.code = code; }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const fmtCode = c => c.slice(0, 4) + "-" + c.slice(4);
function newCode() {
  const r = crypto.randomBytes(8);
  let c = "";
  for (const b of r) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return c;
}
const hash = s => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
const dayOf = (now, tz = "America/Chicago") =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

async function settings(db) {
  const s = await db.doc("appConfig/access").get();
  return { inviteOnly: s.exists ? !!s.get("inviteOnly") : false };
}

async function isMember(db, uid) {
  return !!uid && (await db.doc(`members/${uid}`).get()).exists;
}

/** Throws unless the app is open to everyone or this person has been let in. */
async function requireAccess(db, uid) {
  const s = await settings(db);
  if (s.inviteOnly && !(await isMember(db, uid))) {
    throw new AccessError("permission-denied", "Pantry to Plate is in a private test. Enter your invite code first.");
  }
}

/** Counts one action from one source (an IP address or an account) and refuses past the daily cap. */
async function rateLimit(db, key, cap, now = new Date()) {
  const ref = db.doc(`rate/${hash(key)}_${dayOf(now)}`);
  const n = await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const used = s.exists ? s.get("n") || 0 : 0;
    if (used >= cap) return -1;
    tx.set(ref, { n: used + 1, day: dayOf(now) }, { merge: true });
    return used + 1;
  });
  if (n < 0) throw new AccessError("resource-exhausted", "Too many tries from here today. Please try again tomorrow.");
}

// ---------- waitlist ----------
const PICK = {
  household: ["1", "2", "3-4", "5-6", "7+"],
  diets: ["none", "vegetarian", "vegan", "pescatarian", "low carb / keto", "paleo", "gluten-free", "dairy-free", "nut allergy", "other allergy"],
  store: ["Walmart", "Kroger family", "Target", "Aldi", "Publix", "Costco", "H-E-B", "Other"],
  phone: ["iPhone", "Android", "Both"],
  planning: ["I don't plan", "In my head", "Paper or notes", "Another app", "Mealime"],
};
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;

function checkWaitlist(d) {
  if (!d || typeof d !== "object") throw new AccessError("invalid-argument", "The form is empty.");
  const s = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const email = s(d.email, 200).toLowerCase();
  if (!EMAIL.test(email)) throw new AccessError("invalid-argument", "Enter a valid email address.");
  const name = s(d.name, 60);
  if (!name) throw new AccessError("invalid-argument", "Enter your first name.");
  const one = (k) => { const v = s(d[k], 40); if (!PICK[k].includes(v)) throw new AccessError("invalid-argument", "Answer every question."); return v; };
  const diets = Array.isArray(d.diets) ? [...new Set(d.diets.map(x => s(x, 40)).filter(x => PICK.diets.includes(x)))] : [];
  if (!d.consent) throw new AccessError("invalid-argument", "Please agree to be contacted about the test.");
  return {
    email, name,
    household: one("household"), store: one("store"), phone: one("phone"), planning: one("planning"),
    diets: diets.length ? diets : ["none"],
    survey: !!d.survey,
    zip: /^\d{5}$/.test(s(d.zip, 5)) ? s(d.zip, 5) : "",
    source: s(d.source, 60).replace(/[^\w.-]/g, ""),
    note: s(d.note, 500),
  };
}

/** Adds (or updates) a waitlist sign-up. The honeypot field `website` catches simple bots. */
async function joinWaitlist(db, data, { ip, now = new Date(), FieldValue }) {
  if (data && typeof data.website === "string" && data.website) return { ok: true }; // bot: pretend it worked
  const w = checkWaitlist(data);
  await rateLimit(db, `wl:${ip || "unknown"}`, 10, now);
  const ref = db.doc(`waitlist/${hash(w.email)}`);
  const prev = await ref.get();
  await ref.set({ ...w, updated: now, ...(prev.exists ? {} : { created: now, status: "waiting" }) }, { merge: true });
  const ahead = prev.exists ? null : (await db.collection("waitlist").where("status", "==", "waiting").count().get()).data().count;
  return { ok: true, again: prev.exists, position: ahead };
}

// ---------- invites ----------
/** Creates invite codes. Each code can be used by `maxUses` people (a family shares one). */
async function createInvites(db, { count = 1, maxUses = 6, wave = "", note = "", days = 30, by = "", now = new Date() }) {
  count = Math.min(Math.max(1, count | 0), 100);
  maxUses = Math.min(Math.max(1, maxUses | 0), 50);
  const out = [];
  const batch = db.batch();
  for (let i = 0; i < count; i++) {
    const code = newCode();
    out.push(code);
    batch.set(db.doc(`invites/${code}`), {
      maxUses, uses: 0, wave: String(wave).slice(0, 40), note: String(note).slice(0, 200),
      expires: new Date(now.getTime() + days * 864e5), createdBy: by, created: now, usedBy: [],
    });
  }
  await batch.commit();
  return out.map(fmtCode);
}

/** Lets a signed-in person in with a code. Using a code twice on the same account is fine. */
async function redeemInvite(db, { uid, email, code, now = new Date() }) {
  if (!uid) throw new AccessError("unauthenticated", "Sign in first, then enter your code.");
  const c = normCode(code);
  if (c.length !== 8) throw new AccessError("invalid-argument", "Invite codes look like ABCD-EF23.");
  await rateLimit(db, `redeem:${uid}`, 15, now);
  const inv = db.doc(`invites/${c}`), mem = db.doc(`members/${uid}`);
  return db.runTransaction(async tx => {
    const [i, m] = await Promise.all([tx.get(inv), tx.get(mem)]);
    if (m.exists) return { ok: true, already: true };
    if (!i.exists) throw new AccessError("not-found", "That invite code isn't valid. Check it and try again.");
    const d = i.data();
    if (d.disabled) throw new AccessError("failed-precondition", "That invite code has been turned off.");
    if (d.expires && d.expires.toDate() < now) throw new AccessError("failed-precondition", "That invite code has expired. Ask for a new one.");
    if ((d.uses || 0) >= d.maxUses) throw new AccessError("resource-exhausted", "That invite code has been used up. Ask for a new one.");
    tx.update(inv, { uses: (d.uses || 0) + 1, usedBy: [...(d.usedBy || []), uid].slice(-50), lastUsed: now });
    tx.set(mem, { email: email || "", code: c, wave: d.wave || "", joined: now });
    return { ok: true, already: false };
  });
}

/** Marks waitlist sign-ups as invited and gives each one its own code. */
async function inviteFromWaitlist(db, { ids, maxUses = 6, wave = "", by = "", now = new Date() }) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new AccessError("invalid-argument", "Pick 1 to 100 people.");
  const out = [];
  for (const id of ids) {
    const ref = db.doc(`waitlist/${String(id).replace(/[^a-f0-9]/g, "")}`);
    const s = await ref.get();
    if (!s.exists) continue;
    const prior = s.get("code");
    const code = prior || (await createInvites(db, { count: 1, maxUses, wave, note: s.get("email"), by, now }))[0];
    await ref.set({ status: "invited", code, invited: now, wave }, { merge: true });
    out.push({ id: s.id, name: s.get("name"), email: s.get("email"), code });
  }
  return out;
}

// ---------- feedback ----------
const KINDS = ["bug", "idea", "confusing", "love"];
async function sendFeedback(db, data, { uid, email, ip, now = new Date() }) {
  if (!data || typeof data !== "object") throw new AccessError("invalid-argument", "Write a few words first.");
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (text.length < 3) throw new AccessError("invalid-argument", "Write a few words first.");
  if (text.length > 2000) throw new AccessError("invalid-argument", "Please keep it under 2,000 characters.");
  const kind = KINDS.includes(data.kind) ? data.kind : "idea";
  await rateLimit(db, `fb:${uid || ip || "unknown"}`, 30, now);
  const ctx = data.context && typeof data.context === "object" ? data.context : {};
  const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const ref = await db.collection("feedback").add({
    kind, text, uid: uid || null, email: email || "", created: now, status: "new",
    context: { version: clip(ctx.version, 20), screen: clip(ctx.screen, 30), device: clip(ctx.device, 200), width: Number(ctx.width) || null },
  });
  return { ok: true, id: ref.id };
}

// ---------- admin views ----------
const plain = d => {
  const o = {};
  for (const [k, v] of Object.entries(d || {})) o[k] = v && typeof v.toDate === "function" ? v.toDate().toISOString() : v;
  return o;
};
async function adminOverview(db) {
  const [wl, inv, fb, s] = await Promise.all([
    db.collection("waitlist").orderBy("created", "desc").limit(300).get(),
    db.collection("invites").orderBy("created", "desc").limit(200).get(),
    db.collection("feedback").orderBy("created", "desc").limit(200).get(),
    settings(db),
  ]);
  return {
    access: s,
    waitlist: wl.docs.map(d => ({ id: d.id, ...plain(d.data()) })),
    invites: inv.docs.map(d => ({ code: fmtCode(d.id), ...plain(d.data()) })),
    feedback: fb.docs.map(d => ({ id: d.id, ...plain(d.data()) })),
  };
}

module.exports = {
  AccessError, PICK, settings, isMember, requireAccess, rateLimit, checkWaitlist, joinWaitlist,
  createInvites, redeemInvite, inviteFromWaitlist, sendFeedback, adminOverview, normCode, fmtCode, hash,
};
