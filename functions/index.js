// Pantry to Plate server functions.
//
// Every AI feature goes through here instead of the browser calling the AI directly, so that:
//  - only signed-in people (in the real app, checked by App Check) can use it,
//  - each person and household has a daily limit,
//  - malformed or oversized requests earn strikes and repeated strikes lock the account for a day,
//  - all AI pauses for everyone if the day's estimated spend passes the budget (or if you flip aiConfig/main.paused).
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineBoolean, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { GoogleGenAI } = require("@google/genai");

const guard = require("./src/guard");
const validate = require("./src/validate");
const ai = require("./src/ai");

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 20 });

// Set ENFORCE_APP_CHECK=false in functions/.env only while App Check is being set up.
const ENFORCE_APP_CHECK = defineBoolean("ENFORCE_APP_CHECK", { default: true });
// Where Vertex AI runs the Gemini models. "global" gives the widest model choice.
const AI_LOCATION = defineString("AI_LOCATION", { default: "global" });

let client = null;
const genai = () => client || (client = new GoogleGenAI({
  vertexai: true,
  project: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
  location: AI_LOCATION.value(),
}));

const callOpts = { enforceAppCheck: ENFORCE_APP_CHECK, timeoutSeconds: 120, memory: "512MiB", concurrency: 40 };

function toHttps(e) {
  if (e instanceof HttpsError) return e;
  if (e instanceof guard.Denied) return new HttpsError(e.code, e.message, e.details);
  if (e instanceof validate.BadInput) return new HttpsError("invalid-argument", e.message);
  if (e instanceof ai.ServiceBusy) return new HttpsError("unavailable", e.message);
  return new HttpsError("internal", "Something went wrong on our side. Please try again.");
}

/** Shared path for the three AI features. */
async function runFeature(req, feature, check) {
  const db = getFirestore();
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to use this feature.");
  let input;
  try { input = check(req.data); }
  catch (e) {
    if (e instanceof validate.BadInput) {
      const lockedUntil = await guard.strike(db, { uid, reason: `${feature}: ${e.message}` });
      logger.warn("bad AI request", { uid, feature, reason: e.message, locked: !!lockedUntil });
    }
    throw toHttps(e);
  }
  let ticket;
  try { ticket = await guard.begin(db, { uid, feature }); }
  catch (e) { throw toHttps(e); }
  try {
    const { result, usage, model } = await ai.run(genai(), feature, input, ticket.cfg.models);
    const usd = await guard.finish(db, ticket, usage, FieldValue);
    logger.info("ai call", { uid, feature, model, usd, household: ticket.household });
    return { result, left: ticket.left };
  } catch (e) {
    logger.error("ai call failed", { uid, feature, error: String(e && e.message || e) });
    await guard.refund(db, ticket, e && e.usage, FieldValue).catch(() => {});
    throw toHttps(e);
  }
}

exports.aiScan = onCall(callOpts, req => runFeature(req, "scan", validate.scan));
exports.aiImport = onCall(callOpts, req => runFeature(req, "import", validate.importRecipe));
exports.aiSuggest = onCall(callOpts, req => runFeature(req, "suggest", validate.suggest));

/** How many uses are left today, for showing "3 scans left" in the app. Costs no AI. */
exports.aiQuota = onCall({ ...callOpts, timeoutSeconds: 10, memory: "256MiB" }, async req => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to use this feature.");
  const db = getFirestore();
  const cfg = await guard.config(db);
  const day = guard.dayOf(new Date(), cfg.timeZone);
  const used = (await db.doc(`aiUsage/${uid}_${day}`).get()).data() || {};
  const left = {};
  for (const f of ["scan", "import", "suggest"]) left[f] = Math.max(0, cfg.limits[f].person - (used[f] || 0));
  return { left, paused: !!cfg.paused };
});

/** Ingredient names that still need a Walmart link; read by the daily product-link check. */
exports.requestProducts = onCall({ ...callOpts, timeoutSeconds: 20, memory: "256MiB" }, async req => {
  const db = getFirestore();
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  let items;
  try { items = validate.productRequests(req.data); }
  catch (e) {
    if (e instanceof validate.BadInput) await guard.strike(db, { uid, reason: `products: ${e.message}` });
    throw toHttps(e);
  }
  if (!items.length) return { saved: 0 };
  try { await guard.begin(db, { uid, feature: "products", count: items.length }); }
  catch (e) { throw toHttps(e); }
  const batch = db.batch();
  for (const it of items) {
    const id = it.name.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item";
    batch.set(db.doc(`productRequests/${id}`), { name: it.name, section: it.section, requestedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await batch.commit();
  return { saved: items.length };
});
