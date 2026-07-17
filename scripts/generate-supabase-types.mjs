import { existsSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("../", import.meta.url).pathname);
const destination = resolve(root, "src/lib/supabase/database.types.ts");
const temporary = `${destination}.tmp`;
const linkedRefPath = resolve(root, "supabase/.temp/project-ref");
const projectRef = (process.env.SUPABASE_PROJECT_REF ?? (existsSync(linkedRefPath) ? readFileSync(linkedRefPath, "utf8") : "")).trim();
const timeoutMs = Number(process.env.SUPABASE_TYPES_TIMEOUT_MS ?? 180000);

function removeIncompleteDestination() {
  if (existsSync(destination) && statSync(destination).size < 100) rmSync(destination, { force: true });
}

if (!projectRef) {
  removeIncompleteDestination();
  console.error("Supabase project reference saknas. Kör 'npx supabase@2.109.1 link --project-ref DIN_PROJECT_REF' eller sätt SUPABASE_PROJECT_REF.");
  process.exit(1);
}

rmSync(temporary, { force: true });
console.log(`Genererar Supabase-typer för ${projectRef} med timeout ${Math.round(timeoutMs / 1000)} sekunder...`);

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(executable, [
  "--yes",
  "supabase@2.109.1",
  "gen",
  "types",
  "typescript",
  "--project-id",
  projectRef,
  "--schema",
  "public",
], {
  cwd: root,
  encoding: "utf8",
  timeout: timeoutMs,
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
});

if (result.error || result.status !== 0) {
  rmSync(temporary, { force: true });
  removeIncompleteDestination();
  if (result.error?.code === "ETIMEDOUT") {
    console.error("Supabase typgenerering avbröts efter timeout. Den tidigare typfilen har behållits.");
  } else {
    console.error(`Supabase typgenerering misslyckades${result.status === null ? "" : ` med exitkod ${result.status}`}.`);
  }
  process.exit(result.status ?? 1);
}

const output = result.stdout ?? "";
if (output.length < 1000 || !output.includes("export type Database")) {
  rmSync(temporary, { force: true });
  removeIncompleteDestination();
  console.error("Supabase returnerade inte en giltig Database-typ. Den tidigare typfilen har behållits.");
  process.exit(1);
}

writeFileSync(temporary, output, "utf8");
renameSync(temporary, destination);
console.log(`Skrev ${output.length.toLocaleString("sv-SE")} byte till src/lib/supabase/database.types.ts.`);
