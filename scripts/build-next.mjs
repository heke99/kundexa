import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const nextBin = resolve("node_modules/next/dist/bin/next");
const result = spawnSync(process.execPath, [nextBin, "build"], {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PRIVATE_BUILD_WORKER: "1",
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
