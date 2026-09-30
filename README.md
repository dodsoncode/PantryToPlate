# Pantry to Plate

Weekly dinner planner: pantry check → plan → shopping list → prep & cook.
A static site (no build step) with optional Google sign-in and Firebase sync, set up the same way as Anchor.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
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
     **inside your existing rules** so Anchor's rules keep working. Publish.
4. Open the site, tap **Sign in with Google to sync**. On your phone, use *Share → Add to Home Screen*.

## How sync works

- Each account gets one Firestore document: `pantryToPlate/{uid}` holding pantry, week plan, checkmarks and custom recipes.
- The first time you sign in, whatever is on that device is uploaded. After that, the account copy wins, and changes appear live on your other devices.
- Signed out (or with no config), everything still works and saves in that browser only.

## Editing recipes

Built-in recipes live in the `RECIPES` array near the top of the script in `index.html`.
Each ingredient is `[quantity, unit, name, store section]`, based on the recipe's `serves` count; the app scales to the servings you pick.
Recipes you add in the app are saved to your account instead.
