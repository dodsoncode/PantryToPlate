// Daily limits, account lockouts and the app-wide spending safety valve.
//
// Firestore documents (server-only; the security rules deny all client access):
//   aiConfig/main          settings you can change in the Firebase console without redeploying
//                          (paused, dailyBudgetUsd, limits, models, prices, strikesBeforeLock, lockHours)
//   aiUsage/{uid}_{day}    one person's counts for one day
//   aiUsage/h_{code}_{day} one household's counts for one day
//   aiGlobal/{day}         everyone's calls and estimated spend for one day
//   aiLocks/{uid}          strikes for bad requests, and a lock-until time
// Days are calendar days in US Central time, so limits reset at midnight Central.
"use strict";

const DEFAULTS = Object.freeze({
  paused: false,
  dailyBudgetUsd: 20,
  limits: {
    scan: { person: 5, household: 10 },
    import: { person: 10, household: 20 },
    suggest: { person: 5, household: 10 },
    products: { person: 200, household: 400 }, // ingredient names sent for store links
  },
  strikesBeforeLock: 5,
  lockHours: 24,
  // Tried in order; the next one is used when a model is busy or over quota.
  models: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash"],
  // US dollars per million tokens, used only to estimate spend for the safety valve.
  // Set these to the current list prices in aiConfig/main.
  prices: { inputPerMillion: 0.5, outputPerMillion: 3 },
  timeZone: "America/Chicago",
});

const NAMES = { scan: "pantry scans", import: "recipe imports", suggest: "recipe suggestions", products: "store-link lookups" };

class Denied extends Error {
  constructor(code, message, details) { super(message); this.name = "Denied"; this.code = code; this.details = details; }
}

function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) && over.length ? over : base;
  if (!base || typeof base !== "object") return over === undefined ? base : over;
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

let cache = { at: 0, cfg: null };
async function config(db, { fresh = false } = {}) {
  if (!fresh && cache.cfg && Date.now() - cache.at < 60_000) return cache.cfg;
  const snap = await db.doc("aiConfig/main").get();
  cache = { at: Date.now(), cfg: merge(DEFAULTS, snap.exists ? snap.data() : {}) };
  return cache.cfg;
}
function resetConfigCache() { cache = { at: 0, cfg: null }; }

const dayOf = (now, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

// The household counts only if this person really is a member of it.
async function householdOf(db, uid) {
  const me = await db.doc(`pantryToPlate/${uid}`).get();
  const code = me.exists ? me.get("household") : null;
  if (!code || typeof code !== "string" || !/^[A-Z0-9]{4,20}$/.test(code)) return null;
  const h = await db.doc(`households/${code}`).get();
  return h.exists && Array.isArray(h.get("members")) && h.get("members").includes(uid) ? code : null;
}

const fmtTime = (d, tz) => d.toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });

/** Checks sign-in, locks, the safety valve and the daily limits, then reserves one use. */
async function begin(db, { uid, feature, count = 1, now = new Date() }) {
  if (!uid) throw new Denied("unauthenticated", "Sign in to use this feature.");
  const cfg = await config(db);
  if (cfg.paused) throw new Denied("unavailable", "AI features are paused for a little while. Please try again later.");
  const lim = cfg.limits[feature];
  if (!lim) throw new Denied("internal", "Unknown feature.");
  const day = dayOf(now, cfg.timeZone);
  const household = await householdOf(db, uid);
  const refs = {
    lock: db.doc(`aiLocks/${uid}`),
    global: db.doc(`aiGlobal/${day}`),
    person: db.doc(`aiUsage/${uid}_${day}`),
    house: household ? db.doc(`aiUsage/h_${household}_${day}`) : null,
  };
  return db.runTransaction(async tx => {
    const [lock, glob, person, house] = await Promise.all([
      tx.get(refs.lock), tx.get(refs.global), tx.get(refs.person), refs.house ? tx.get(refs.house) : null,
    ]);
    const until = lock.exists && lock.get("until") ? lock.get("until").toDate() : null;
    if (until && until > now) {
      throw new Denied("resource-exhausted", `AI features are paused on this account until ${fmtTime(until, cfg.timeZone)} because of repeated bad requests.`, { lockedUntil: until.toISOString() });
    }
    if (feature !== "products" && glob.exists && (glob.get("spendUsd") || 0) >= cfg.dailyBudgetUsd) {
      throw new Denied("unavailable", "AI features have reached today's limit for everyone. They come back at midnight Central time.");
    }
    const pUsed = person.exists ? person.get(feature) || 0 : 0;
    const hUsed = house && house.exists ? house.get(feature) || 0 : 0;
    if (pUsed + count > lim.person) {
      throw new Denied("resource-exhausted", `You've used all ${lim.person} ${NAMES[feature]} for today. They reset at midnight Central time.`, { feature, limit: lim.person, scope: "person" });
    }
    if (house && hUsed + count > lim.household) {
      throw new Denied("resource-exhausted", `Your household has used all ${lim.household} ${NAMES[feature]} for today. They reset at midnight Central time.`, { feature, limit: lim.household, scope: "household" });
    }
    const stamp = { day, updated: now };
    tx.set(refs.person, { ...stamp, uid, [feature]: pUsed + count }, { merge: true });
    if (house) tx.set(refs.house, { ...stamp, household, [feature]: hUsed + count }, { merge: true });
    if (feature !== "products") tx.set(refs.global, { ...stamp, calls: (glob.exists ? glob.get("calls") || 0 : 0) + 1 }, { merge: true });
    return {
      uid, household, feature, day, count, cfg, refs,
      left: { person: lim.person - pUsed - count, household: house ? lim.household - hUsed - count : null },
    };
  });
}

const costUsd = (usage, cfg) => {
  if (!usage) return 0;
  const inp = usage.promptTokenCount || 0, out = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  return (inp * cfg.prices.inputPerMillion + out * cfg.prices.outputPerMillion) / 1e6;
};

/** Records what a successful call cost against the day's budget. */
async function finish(db, ticket, usage, FieldValue) {
  const usd = costUsd(usage, ticket.cfg);
  if (!usd) return 0;
  await Promise.all([
    ticket.refs.global.set({ spendUsd: FieldValue.increment(usd) }, { merge: true }),
    ticket.refs.person.set({ spendUsd: FieldValue.increment(usd) }, { merge: true }),
  ]);
  return usd;
}

/** Gives the use back when the AI service itself failed (busy, quota), so people aren't charged for our outage. */
async function refund(db, ticket, usage, FieldValue) {
  const dec = FieldValue.increment(-ticket.count);
  const jobs = [ticket.refs.person.set({ [ticket.feature]: dec }, { merge: true })];
  if (ticket.refs.house) jobs.push(ticket.refs.house.set({ [ticket.feature]: dec }, { merge: true }));
  const usd = costUsd(usage, ticket.cfg);
  if (usd) jobs.push(ticket.refs.global.set({ spendUsd: FieldValue.increment(usd) }, { merge: true }));
  await Promise.all(jobs);
}

/** One strike for a malformed or oversized request; enough strikes in a day lock the account's AI features. */
async function strike(db, { uid, reason, now = new Date() }) {
  if (!uid) return null;
  const cfg = await config(db);
  const ref = db.doc(`aiLocks/${uid}`);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const since = new Date(now.getTime() - 24 * 3600e3);
    const recent = (s.exists ? s.get("strikes") || [] : []).filter(x => new Date(x.at) > since).slice(-20);
    recent.push({ at: now.toISOString(), reason: String(reason || "").slice(0, 120) });
    const data = { strikes: recent, updated: now };
    if (recent.length >= cfg.strikesBeforeLock) data.until = new Date(now.getTime() + cfg.lockHours * 3600e3);
    tx.set(ref, data, { merge: true });
    return data.until || null;
  });
}

module.exports = { DEFAULTS, Denied, config, resetConfigCache, dayOf, begin, finish, refund, strike, costUsd, merge };
