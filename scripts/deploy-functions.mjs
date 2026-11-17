import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Deployar Edge-funktionerna, och tar bort de som lämnat repot.
 *
 * Listan var tidigare handskriven här. Två saker följde av det: en ny funktion
 * kördes inte förrän någon kom ihåg att fylla på listan, och en borttagen
 * funktion låg kvar i produktionen för alltid. Det andra hände: källkoden till
 * den gamla leverantörens arbetare togs bort, dess databasfunktioner droppades,
 * och ändå låg funktionen kvar ACTIVE och anropbar i tre dagar innan en
 * avstämning hittade den. Deployen deployar det som finns i repot -- den tog
 * aldrig bort det som försvunnit ur det.
 *
 * Listan läses nu ur katalogen. Att byta en handskriven lista mot en annan hade
 * inte löst något.
 */

const functionsDir = "supabase/functions";

/**
 * Funktioner som medvetet tagits bort och ska bort ur produktionen.
 *
 * Uppräkning, inte mönster -- samma regel som leverantörsskanningen i
 * `verify.mjs`. En regel som "ta bort allt i produktionen som inte finns i
 * repot" hade varit bekvämare, men den raderar också en funktion som någon just
 * deployat för hand under en incident, och den läser en utdataform vi inte
 * kontrollerar. Det här är en rad per beslut, och beslutet syns i diffen.
 */
const RETIRED = ["rinkel-platform-worker"];

function repositoryFunctions() {
  return readdirSync(functionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(functionsDir, name, "index.ts")))
    .sort();
}

const extraArgs = process.argv.slice(2);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function supabase(args) {
  const result = spawnSync(npx, ["supabase@2.109.1", ...args], { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.status === 0;
}

const functions = repositoryFunctions();
// En tom lista betyder att något är fel med katalogen, inte att allt ska bort.
// Utan den här spärren hade en felaktig sökväg tagit ner hela produktionen.
if (functions.length === 0) {
  console.error(`No Edge Functions found under ${functionsDir}; refusing to continue.`);
  process.exit(1);
}

// Fail before the first mutation if the target DB lacks the RPC/schema package.
// The Management API query is read-only and returns migration versions only.
const preflight = spawnSync(process.execPath, ["scripts/check-deployment-schema.mjs", ...extraArgs], { stdio: "inherit", shell: false });
if (preflight.error) throw preflight.error;
if (preflight.status !== 0) process.exit(preflight.status ?? 1);

for (const functionName of functions) {
  console.log(`\nDeploying ${functionName}...`);
  supabase(["functions", "deploy", functionName, "--no-verify-jwt", ...extraArgs]);
}

// Read the inventory successfully before interpreting any function as absent.
const inventoryResult = spawnSync(npx, ["supabase@2.109.1", "functions", "list", ...extraArgs, "--output", "json"], {
  stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell: false,
});
if (inventoryResult.error) throw inventoryResult.error;
if (inventoryResult.status !== 0) process.exit(inventoryResult.status ?? 1);
const inventory = JSON.parse(inventoryResult.stdout);
if (!Array.isArray(inventory) || inventory.some((entry) => !entry || typeof entry.name !== "string")) {
  throw new Error("Unexpected function inventory; refusing cleanup.");
}
const deployedNames = new Set(inventory.map((entry) => entry.name));
for (const functionName of RETIRED) {
  if (functions.includes(functionName)) {
    throw new Error(`${functionName} is retired but still exists in ${functionsDir}.`);
  }
  if (!deployedNames.has(functionName)) {
    console.log(`${functionName} is absent in the verified inventory.`);
    continue;
  }
  console.log(`Removing retired ${functionName}...`);
  supabase(["functions", "delete", functionName, ...extraArgs]);
  console.log(`Removed ${functionName}.`);
}
