begin;
-- New stale-worker recovery queries are not covered by the old queued-only indexes.
create index if not exists ingestion_runs_stale_running_idx on public.ingestion_runs(locked_at,created_at) where status='running' and completed_at is null;
create index if not exists parsehub_runs_stale_processing_idx on public.parsehub_runs(locked_at,created_at) where status='processing';
-- Fenced checkpoints use tenant+run equality. This also covers their run FK.
create index if not exists crawl_checkpoints_tenant_run_idx on public.crawl_checkpoints(tenant_id,ingestion_run_id,crawl_plan_id);
create index if not exists ingestion_runs_tenant_job_history_idx on public.ingestion_runs(tenant_id,ingestion_job_id,created_at);
commit;
