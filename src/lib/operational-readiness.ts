export type WorkerState = { worker_key: string; status: string; updated_at: string };
export const REQUIRED_WORKERS = ["process-outbox", "maintenance-worker", "automation-runner", "compliance-worker", "data-worker", "ingestion-worker", "parsehub-worker"] as const;
export function evaluateWorkerReadiness(workers: WorkerState[], now: number) {
  return REQUIRED_WORKERS.map(key => {
    const worker = workers.find(row => row.worker_key === key);
    const ageMs = worker ? now - Date.parse(worker.updated_at) : NaN;
    return { key, ready: Boolean(worker && worker.status === "healthy" && Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs <= 15 * 60_000) };
  });
}
