import { spawn } from "node:child_process";
import { resolve } from "node:path";

const nextBin = resolve("node_modules/next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "build", "--webpack"], {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
  },
});

child.on("error", (error) => {
  console.error("Kunde inte starta Next.js-builden:", error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Next.js-builden avbröts av signal ${signal}.`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
