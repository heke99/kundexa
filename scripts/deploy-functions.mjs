import { spawnSync } from "node:child_process";

const functions = ["process-outbox", "automation-runner", "data-worker", "ingestion-worker", "maintenance-worker", "compliance-worker", "parsehub-worker"];
const extraArgs = process.argv.slice(2);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

for (const functionName of functions) {
  const args = [
    "supabase@2.109.1",
    "functions",
    "deploy",
    functionName,
    "--no-verify-jwt",
    ...extraArgs,
  ];
  console.log(`\nDeploying ${functionName}...`);
  const result = spawnSync(npx, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
