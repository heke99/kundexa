import { spawn } from "node:child_process";
import { resolve } from "node:path";

const nextBin = resolve("node_modules/next/dist/bin/next");
const maxAttempts = 3;
const timeoutMs = 180_000;

function runBuildAttempt() {
  return new Promise((resolveAttempt) => {
    const detached = process.platform !== "win32";
    const child = spawn(process.execPath, [nextBin, "build"], {
      stdio: "inherit",
      shell: false,
      detached,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PRIVATE_BUILD_WORKER: "1",
      },
    });

    let timedOut = false;
    let forceKillTimer;
    const heartbeat = setInterval(() => console.log("Next build is still running..."), 10_000);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // The process may have exited between the timer and kill call.
      }
      forceKillTimer = setTimeout(() => {
        try {
          if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already terminated.
        }
      }, 5_000);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveAttempt({ status: 1, timedOut, error });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveAttempt({ status: code ?? 1, timedOut, signal });
    });
  });
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = await runBuildAttempt();
  if (!result.error && result.status === 0) process.exit(0);

  if (result.timedOut && attempt < maxAttempts) {
    console.warn(`Next build worker timed out on attempt ${attempt}; retrying with retained build cache.`);
    continue;
  }

  if (result.error) throw result.error;
  console.error(`Next build failed with status ${result.status}${result.signal ? ` (${result.signal})` : ""}.`);
  process.exit(result.status || 1);
}
