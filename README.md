# Feed the Nest

_App name: Feed the Nest. The repo, code, Firebase project and file names still use the working name Pantry to Plate._

Weekly dinner planner: pantry check → plan → shopping list → prep & cook.
A static site (no build step) with optional Google sign-in and Firebase sync, set up the same way as Anchor.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `recipes.js` | The recipe library: 90 original breakfasts, lunches and dinners |
| `firebase-config.js` | Your Firebase web config (fill in) |
| `firestore.rules` | Security rules block for the planner's data |
| `manifest.webmanifest`, `icon*.png`, `icon.svg` | "Add to Home Screen" support |
| `netlify.toml` | Netlify settings (publish the repo root, no build) |

## Setup

1. **GitHub** – Create a repo (e.g. `dodsoncode/PantryToPlate`) and upload these files to its root.
2. **Netlify** – *Add new site → Import an existing project → GitHub* → pick the repo.
   Leave the build command empty; publish directory is `.`. Every push to `main` redeploys.
3. **Firebase** (you can reuse Anchor's project):
   - *Project settings → Your apps → Web app* → copy the config into `firebase-config.js`.
   - *Authentication → Settings → Authorized domains* → add your new Netlify domain (e.g. `pantry-to-plate.netlify.app`).
   - *Firestore → Rules* → add the `match /pantryToPlate/{uid}` block from `firestore.rules`
     **inside your existing rules** so Anchor's rules keep working. Add the `households` block too for sharing. Publish.
4. Open the site, tap **Sign in with Google to sync**. On your phone, use *Share → Add to Home Screen*.

## How the app is laid out

Five tabs along the bottom, plus Settings (gear, top right). New devices start with a short setup: who's eating, diet, allergies and foods to avoid (per person), dislikes, and which meals to plan.

| Tab | What it's for |
|---|---|
| **Today** | Tonight's dinner with its photo and a big *Start cooking* button, breakfast and lunch if you plan them, reminders, and the week at a glance. With nothing planned it shows one button: *Build the plan*. |
| **Plan** | The dated week. Tap a day to choose a meal (photos, leftovers marked ♻), or *Fill empty nights for me*. |
| **Recipes** | Photo rows (ready with what you have, favorites, 20 minutes or less, make ahead, your recipes) and a grid of everything for the chosen meal. **+** adds to the plan; tapping opens the recipe page: big photo, Ingredients / Steps / Tools tabs, servings and *Add to the plan* at the bottom. *+ Add* imports from a link, photo or pasted text, or suggests new recipes. |
| **Shop** | Everything missing for the week, by aisle. **Put away ✓** adds the groceries to the Kitchen. Send the list to Walmart, Kroger, Target, Amazon Fresh or Instacart. |
| **Kitchen** | What you have, with amounts, low flags and photo scan. |

Photos are placeholders (a plate on a colored tablecloth, picked from the recipe name). Give a recipe an `img` URL to show a real photo instead.
Cook mode shows each step with the ingredients it uses, timers, hands-free voice control, and keeps the screen awake.

## Server functions (AI limits and abuse protection)

The `functions/` folder holds the server side. Once deployed and switched on, every AI feature (pantry photo scan, recipe import, recipe suggestions) runs through it instead of the browser calling the AI directly.

- **Sign-in required**, and with App Check on, only requests from the real app are accepted.
- **Daily limits**, reset at midnight Central:

  | Feature | Per person | Per household |
  |---|---|---|
  | Pantry photo scan | 5 | 10 |
  | Recipe import | 10 | 20 |
  | Suggest new recipes (3 per run) | 5 | 10 |

- **Abuse protection:** at most 6 photos of 1.5 MB each, pasted text up to 20,000 characters, and only JPEG/PNG/WebP. Five bad requests in a day lock that account's AI features for 24 hours.
- **Safety valve:** AI pauses for everyone once the day's estimated spend passes $20. A failed AI call gives the use back.
- **Settings without redeploying:** create the Firestore document `aiConfig/main` and set any of `paused` (true/false), `dailyBudgetUsd`, `limits` (for example `limits.scan.person`), `models`, `prices.inputPerMillion`, `prices.outputPerMillion`. Changes apply within a minute.

Turning it on: deploy the functions and rules (`firebase deploy --only functions,firestore:rules`), add the reCAPTCHA Enterprise site key as `APP_CHECK_SITE_KEY` in `firebase-config.js`, and set `USE_SERVER = true`.

Tests: `npm install` in the repo root and in `functions/`, then `npm test` (needs Java for the Firestore emulator). It covers the security rules (8 tests) and the limits, lockouts, safety valve and AI runner (19 tests). Open `http://localhost:8765/?emu` with the emulators running to try the app against them.

## Private test: waitlist, invite codes and feedback

- **`join.html`** is the waitlist page: a short screener (household size, diets, store, phone, how they plan today), stored in `waitlist/`. Add `?src=reddit` (or similar) to links to see where sign-ups come from. Bots are caught by a hidden field and a per-address daily cap.
- **Invite-only** is controlled by `appConfig/access.inviteOnly`. When on, the app shows an invite-code screen after sign-in, and the database rules only let people listed in `members/` save anything. One code can be shared by a family (6 people by default). Invite links look like `index.html?invite=ABCDEF23` and fill the code in.
- **`admin.html`** (for the emails in `ADMIN_EMAILS`, set when deploying the functions): see the waitlist, invite selected people (each gets a code and a ready-to-send message), make codes for friends, turn codes off, turn invite-only on or off, download the waitlist as CSV, and read feedback.
- **Feedback:** Settings → Send feedback, and a link on Today. It saves the message, the kind (something broke, confusing, idea, likes it), the screen, app version and device to `feedback/`.

All of this runs through the server functions, so it switches on with `USE_SERVER`.

## How sync works

- Signed in, your planner lives in Firestore: `pantryToPlate/{uid}`, or `households/{code}` once you share with a household.
- The shared copy is saved **one change at a time** (one pantry item, one checkmark, one night of the plan) using field paths,
  so two people editing at once don't overwrite each other. Pantry items, extras and your recipes are stored as maps keyed by id
  (`state.pantryM`, `state.extrasM`, `state.customM`).
- When an update arrives from someone else, it's combined with any of your changes that haven't been sent yet.
- A household saved in the older whole-planner format is converted automatically the first time an updated phone opens it.
  Reload the app on every phone after updating so no one keeps writing the old format.
- Which tab you're on, cook-mode progress and a *Hungry now* pick stay per person.
- Signed out (or with no config), everything still works and saves in that browser only.

## Editing recipes

Built-in recipes live in the `RECIPES` array near the top of the script in `index.html`.
Each ingredient is `[quantity, unit, name, store section]`, based on the recipe's `serves` count; the app scales to the servings you pick.
Recipes you add in the app are saved to your account instead.
The larger library is in `recipes.js` (`window.LIBRARY`), same shape plus `meal` ("breakfast", "lunch" or "dinner"; dinner if missing).

## Diet, allergies and meals

- **Diet & allergies** (Plan tab → Set up / Edit): a household diet (classic, flexitarian, pescatarian, vegetarian, vegan, low carb, paleo), allergies for the whole household and for each named person, and foods each person dislikes. Recipes that don't fit are hidden from Recipes, Hungry now, the day picker and "Fill"; "Show N that don't fit" brings them back with a warning. Matching is by ingredient name, so always check package labels for allergens.
- **Breakfast & lunch**: the Plan: Breakfast / Lunch / Dinner chips add those meals to every day. They're saved as `monB` / `monL` next to the dinner key `mon`, and they flow into the shopping list, prep session and cook mode.
- **Avoid list**: besides allergies, "No pork", "No red meat" and "No alcohol", plus one-tap common dislikes; dislikes are unlimited.
- **Zero waste**: "Fill" prefers recipes that share fresh ingredients with the rest of the week, and the week view lists what will be left over (half a tub of sour cream, 4 tortillas…). Recipes that would use a leftover are marked ♻ in the day picker. Package sizes for this live in `PERPKG`.
- **Hands-free cooking**: in cook mode, tap 🎙 Hands-free to hear each step read aloud and say "next", "back", "repeat", "timer" (or "set a timer for 5 minutes") or "ingredients". Voice commands need a browser with speech recognition (Chrome, Edge, Safari) and microphone permission; the screen stays awake.
- **Edit any recipe**: Edit on any recipe card (including built-in ones, which saves your own version with "Undo my edits"), and "Edit first" when importing.
- **Stores**: Walmart fills the cart directly; Kroger does once its worker is set up. Target, Amazon Fresh, Instacart and Kroger (before setup) open item-by-item searches.
- **✨ Suggest new recipes** (Recipes view): Gemini writes 3 original recipes for the chosen meal that fit the profile and lean on what's in the kitchen. Review, then save the ones you want.

## Instacart ordering

The Store list's **Order on Instacart** button sends the list to a small Cloudflare Worker
(`instacart-worker.js`), which calls Instacart's *Create shopping list page* API with a secret key
and returns a link. The button stays hidden until `INSTACART_ENDPOINT` is set in `firebase-config.js`.

1. Get a key at https://dashboard.instacart.com (Development keys are self-serve; Production keys need Instacart's approval).
2. Cloudflare → Workers & Pages → Create Worker → paste `instacart-worker.js` → Deploy.
3. Worker → Settings → Variables and Secrets: secret `INSTACART_API_KEY`; while on a Development key also add
   `INSTACART_URL = https://connect.dev.instacart.tools/idp/v1/products/products_link`.
4. Set `window.INSTACART_ENDPOINT` in `firebase-config.js` to the worker's `https://….workers.dev` address.

## Recipe import

Meals → **Import a recipe** reads a recipe page with Gemini (Firebase AI Logic, URL context tool) and
shows a preview before saving it as one of your recipes.

## Walmart cart

On the Store list, **set product** on an item → paste the Walmart product link (`walmart.com/ip/…/<number>`).
Saved products are shared with the household. **Add N items to Walmart cart** opens
`affil.walmart.com/cart/addToCart?items=ID|QTY,…`, which fills the Walmart cart; choose pickup at checkout.

## Kroger cart

Uses Kroger's public API through a Cloudflare Worker (`kroger-worker.js`) that holds the client secret.

1. https://developer.kroger.com → create an account → register an application (Production environment),
   scopes `product.compact` and `cart.basic:write`, redirect URI `https://<worker>.workers.dev/callback`.
2. Cloudflare → Create Worker → paste `kroger-worker.js` → Deploy. Settings → Variables and Secrets:
   `KROGER_CLIENT_ID` (variable) and `KROGER_CLIENT_SECRET` (secret).
3. Set `window.KROGER_ENDPOINT` in `firebase-config.js` to the worker address. A Kroger tab appears in **Send to a store**:
   pick a store by ZIP, connect your Kroger account once per device, then **Add N items to Kroger cart** (pickup or delivery).

## Recipe photos

`photos.json` keeps the photo choice for each recipe:
- `real` is the stock photo picked on 2026-10-04. Each one is saved in `img/real/` with its photographer, source page and license (Unsplash or Pexels; neither requires credit, but the app will show it anyway).
- `ai` is filled in by `scripts/gen-photos.mjs`. That script makes AI pictures in one house style for comparison. It needs the new project with billing and Vertex AI turned on; the script's top comment explains how to run it.
- `chosen` is the final pick (`"real"` or `"ai"`). The app keeps showing placeholder plates until a recipe has one.
