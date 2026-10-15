export type WorkerState = { worker_key: string; status: string; updated_at: string };
export const REQUIRED_WORKERS = ["process-outbox", "maintenance-worker", "automation-runner", "compliance-worker", "data-worker", "ingestion-worker", "parsehub-worker"] as const;
export function evaluateWorkerReadiness(workers: WorkerState[], now: number) {
  return REQUIRED_WORKERS.map(key => {
    const worker = workers.find(row => row.worker_key === key);
    const ageMs = worker ? now - Date.parse(worker.updated_at) : NaN;
    return { key, ready: Boolean(worker && worker.status === "healthy" && Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs <= 15 * 60_000) };
  });
}

export function evaluateSigningWorkerReadiness(input: { templateCount: number | null; pendingCount: number | null; readFailed: boolean; heartbeat?: WorkerState; now: number }) {
  const required = (input.templateCount ?? 0) > 0 || (input.pendingCount ?? 0) > 0;
  const ageMs = input.heartbeat ? input.now - Date.parse(input.heartbeat.updated_at) : NaN;
  const ready = !input.readFailed && (!required || Boolean(input.heartbeat && input.heartbeat.status === "healthy" && Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs <= 15 * 60_000));
  return { required, ready };
}

/** Compare effective configuration only; this does not establish Resend account ownership. */
export function matchingEmailConfiguration(workerDigest: unknown, webDigest: string | null) {
  return typeof workerDigest === "string" && /^[a-f0-9]{64}$/.test(workerDigest) && Boolean(webDigest) && workerDigest === webDigest;
}
export function everyTenantEmailWebhookVerified(integrations: Array<{ tenantId: string; verified: boolean }>) {
  const tenants = new Map<string, boolean>();
  for (const integration of integrations) tenants.set(integration.tenantId, Boolean(tenants.get(integration.tenantId)) || integration.verified);
  return tenants.size > 0 && [...tenants.values()].every(Boolean);
}
