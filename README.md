# Pantry to Plate

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

Four tabs along the bottom, sized for one-handed use on an iPhone:

| Tab | What it's for |
|---|---|
| **Today** | Tonight's dinner with a big *Start cooking* button, reminders (thaw tomorrow's meat, prep tasks left, things to buy, running low), and the week at a glance. *Hungry now?* finds something you can make with what's here. |
| **Kitchen** | What you have. Type several foods at once (`milk, 2 lb chicken, eggs`); each goes to its usual spot. Tap **Low** to flag something, × to remove (with Undo). Photo scan is here too. |
| **Plan** | *This week*: tap a night to choose its dinner, or *Fill empty nights for me*. Servings live here. *Recipes*: search, filter, import a recipe from a link, photo or pasted text. |
| **Shop** | Everything missing for the week, by aisle. Tap a row to check it; it moves to *In the cart* with the initial of whoever checked it. **Put away ✓** adds the groceries to the Kitchen. Send the list to Instacart, Walmart or Kroger from *Send the list…*. |

Cook mode opens from Today: full screen, one step at a time, tap-to-start timers, and the screen stays awake.
Prep (from Today) groups the week's make-ahead tasks so all the chopping happens together.

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
