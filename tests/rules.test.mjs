// Security-rule tests. Run with: npm run test:rules (starts the Firestore emulator).
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove, deleteField } from "firebase/firestore";

let env;
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-ptp",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host, port: +port },
  });
});
after(() => env && env.cleanup());
beforeEach(() => env.clearFirestore());

const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const seed = fn => env.withSecurityRulesDisabled(c => fn(c.firestore()));
const HOUSE = "ABCDE23456";

test("a person reads and writes only their own planner", async () => {
  await assertSucceeds(setDoc(doc(as("alice"), "pantryToPlate/alice"), { state: { pantry: {} }, updated: 1 }));
  await assertSucceeds(getDoc(doc(as("alice"), "pantryToPlate/alice")));
  await assertFails(getDoc(doc(as("bob"), "pantryToPlate/alice")));
  await assertFails(setDoc(doc(as("bob"), "pantryToPlate/alice"), { state: {} }));
  await assertFails(getDoc(doc(anon(), "pantryToPlate/alice")));
});

test("a planner holds only the expected fields and a valid household code", async () => {
  await assertFails(setDoc(doc(as("alice"), "pantryToPlate/alice"), { state: {}, admin: true }));
  await assertFails(setDoc(doc(as("alice"), "pantryToPlate/alice"), { state: {}, household: "../x" }));
  await assertSucceeds(setDoc(doc(as("alice"), "pantryToPlate/alice"), { state: {}, household: HOUSE }));
  await assertSucceeds(updateDoc(doc(as("alice"), "pantryToPlate/alice"), { household: deleteField() }));
});

test("starting a household makes you its only member", async () => {
  await assertSucceeds(setDoc(doc(as("alice"), `households/${HOUSE}`), { members: ["alice"], names: { alice: "Alice" }, state: {} }));
  await assertFails(setDoc(doc(as("bob"), "households/ZZZZZ99999"), { members: ["bob", "carol"], state: {} }));
  await assertFails(setDoc(doc(as("bob"), "households/ZZZZZ88888"), { members: ["alice"], state: {} }));
});

test("only members can read a household", async () => {
  await seed(db => setDoc(doc(db, `households/${HOUSE}`), { members: ["alice"], names: { alice: "Alice" }, state: { plan: {} } }));
  await assertSucceeds(getDoc(doc(as("alice"), `households/${HOUSE}`)));
  await assertFails(getDoc(doc(as("mallory"), `households/${HOUSE}`)));
  await assertFails(getDoc(doc(anon(), `households/${HOUSE}`)));
});

test("joining with the code adds only yourself", async () => {
  await seed(db => setDoc(doc(db, `households/${HOUSE}`), { members: ["alice"], names: { alice: "Alice" }, state: { plan: { mon: "x" } } }));
  await assertSucceeds(updateDoc(doc(as("bob"), `households/${HOUSE}`), { members: arrayUnion("bob"), "names.bob": "Bob" }));
  // A joiner can't touch the planner, add someone else, or rename others.
  await assertFails(updateDoc(doc(as("carol"), `households/${HOUSE}`), { members: arrayUnion("carol"), "state.plan.mon": "y" }));
  await assertFails(updateDoc(doc(as("carol"), `households/${HOUSE}`), { members: arrayUnion("carol", "dave") }));
  await assertFails(updateDoc(doc(as("carol"), `households/${HOUSE}`), { members: arrayUnion("carol"), "names.alice": "hacked" }));
});

test("members edit the planner and can leave, but can't remove others", async () => {
  await seed(db => setDoc(doc(db, `households/${HOUSE}`), { members: ["alice", "bob"], names: { alice: "Alice", bob: "Bob" }, state: { plan: {} } }));
  await assertSucceeds(updateDoc(doc(as("bob"), `households/${HOUSE}`), { "state.plan.mon": "tacos" }));
  await assertFails(updateDoc(doc(as("bob"), `households/${HOUSE}`), { members: arrayRemove("alice") }));
  await assertFails(updateDoc(doc(as("bob"), `households/${HOUSE}`), { members: arrayUnion("mallory") }));
  await assertSucceeds(updateDoc(doc(as("bob"), `households/${HOUSE}`), { members: arrayRemove("bob"), "names.bob": deleteField() }));
  await assertFails(getDoc(doc(as("bob"), `households/${HOUSE}`)));
});

test("product requests: anyone reads, nobody writes from the app", async () => {
  await seed(db => setDoc(doc(db, "productRequests/salsa"), { name: "salsa" }));
  await assertSucceeds(getDoc(doc(anon(), "productRequests/salsa")));
  await assertFails(setDoc(doc(as("alice"), "productRequests/salsa"), { name: "salsa" }));
  await assertFails(deleteDoc(doc(as("alice"), "productRequests/salsa")));
});

test("AI limit, lock, spend and settings documents are closed to the app", async () => {
  for (const path of ["aiUsage/alice_2026-10-04", "aiLocks/alice", "aiGlobal/2026-10-04", "aiConfig/main"]) {
    await assertFails(getDoc(doc(as("alice"), path)));
    await assertFails(setDoc(doc(as("alice"), path), { scan: 0 }));
  }
});

test("invite-only: without a membership you can't save; with one you can", async () => {
  await seed(db => setDoc(doc(db, "appConfig/access"), { inviteOnly: true }));
  await assertSucceeds(getDoc(doc(anon(), "appConfig/access")));
  await assertFails(setDoc(doc(as("alice"), "pantryToPlate/alice"), { state: {} }));
  await assertFails(setDoc(doc(as("alice"), `households/${HOUSE}`), { members: ["alice"], state: {} }));
  await seed(db => setDoc(doc(db, "members/alice"), { code: "ABCDEF23" }));
  await assertSucceeds(setDoc(doc(as("alice"), "pantryToPlate/alice"), { state: {} }));
  await assertSucceeds(getDoc(doc(as("alice"), "members/alice")));
  await assertFails(getDoc(doc(as("bob"), "members/alice")));
  await assertFails(setDoc(doc(as("bob"), "members/bob"), { code: "x" }));
  await seed(db => setDoc(doc(db, "appConfig/access"), { inviteOnly: false }));
  await assertSucceeds(setDoc(doc(as("bob"), "pantryToPlate/bob"), { state: {} }));
});

test("waitlist, invites, feedback and rate counters are closed to the app", async () => {
  for (const path of ["waitlist/abc", "invites/ABCDEF23", "feedback/x", "rate/x_2026-10-04"]) {
    await assertFails(getDoc(doc(as("alice"), path)));
    await assertFails(setDoc(doc(as("alice"), path), { a: 1 }));
  }
  await assertFails(setDoc(doc(as("alice"), "appConfig/access"), { inviteOnly: false }));
});
