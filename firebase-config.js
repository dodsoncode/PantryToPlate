// Firebase web config (shared with Anchor's project). These values are public by design;
// access is controlled by Firestore rules and Authentication's authorized domains.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDV4Z3DwgsjUdF3hjLHjTl8WTJsx1dNfHM",
  authDomain: "anchor-productivity-48827.firebaseapp.com",
  projectId: "anchor-productivity-48827",
  storageBucket: "anchor-productivity-48827.firebasestorage.app",
  messagingSenderId: "480059595784",
  appId: "1:480059595784:web:c2cca9b909f224b96785bd",
  measurementId: "G-77891QBWK9"
};

// The new dedicated Pantry to Plate project. Not in use yet: the live app keeps using the config above
// until the data is copied over and the rules and functions are deployed, then this replaces it.
window.FIREBASE_CONFIG_NEXT = {
  apiKey: "AIzaSyCQd0Y_LtKkVH9zle7UmAmO2okwZxXPAvY",
  authDomain: "pantry-to-plate-f728c.firebaseapp.com",
  projectId: "pantry-to-plate-f728c",
  storageBucket: "pantry-to-plate-f728c.firebasestorage.app",
  messagingSenderId: "215627006626",
  appId: "1:215627006626:web:105544e74a0d8f32984dfb"
};

// Instacart ordering: the address of your Cloudflare Worker (see instacart-worker.js).
// Leave empty to hide the "Order on Instacart" button.
window.INSTACART_ENDPOINT = "";

// Kroger ordering: the address of your Kroger Cloudflare Worker (see kroger-worker.js).
// Leave empty to hide the Kroger tab.
window.KROGER_ENDPOINT = "";

// Server-side AI (sign-in, daily limits, abuse protection). Turn on after the functions are deployed
// to the new Pantry to Plate Firebase project; until then the app uses the older direct AI calls.
window.USE_SERVER = false;

// App Check site key (reCAPTCHA Enterprise) for abuse protection. Fill in once it's registered.
window.APP_CHECK_SITE_KEY = "";
