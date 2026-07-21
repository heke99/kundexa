begin;

alter table public.parsehub_runs
  add column if not exists run_token_ciphertext text,
  add column if not exists locked_by text,
  add column if not exists locked_at timestamptz,
  add column if not exists webhook_received_at timestamptz,
  add column if not exists response_sha256 text,
  add column if not exists response_size_bytes bigint;

create index if not exists parsehub_runs_claim_idx
  on public.parsehub_runs(status,next_attempt_at,created_at)
  where status in ('queued','failed');

create or replace function public.claim_parsehub_runs(p_worker text,p_limit integer default 5)
returns setof public.parsehub_runs
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(nullif(trim(p_worker),''),'')='' then raise exception 'worker_required'; end if;
  return query
  with candidates as (
    select id
    from public.parsehub_runs
    where status in ('queued','failed')
      and run_token_ciphertext is not null
      and (next_attempt_at is null or next_attempt_at<=now())
      and (locked_at is null or locked_at<now()-interval '15 minutes')
      and attempts<8
    order by created_at
    for update skip locked
    limit greatest(1,least(coalesce(p_limit,5),25))
  )
  update public.parsehub_runs r
  set status='processing',locked_by=left(p_worker,120),locked_at=now(),attempts=r.attempts+1,updated_at=now()
  from candidates c
  where r.id=c.id
  returning r.*;
end $$;

create or replace function public.process_parsehub_import_run(p_parsehub_run_id uuid)
returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_import_run uuid;
  v_profile uuid;
  v_actor uuid;
  v_auto boolean;
  v_result jsonb;
begin
  select pr.import_run_id,pr.import_profile_id,ip.created_by,ip.automatic_commit
  into v_import_run,v_profile,v_actor,v_auto
  from public.parsehub_runs pr
  join public.import_profiles ip on ip.tenant_id=pr.tenant_id and ip.id=pr.import_profile_id
  where pr.id=p_parsehub_run_id and pr.status='processing'
  for update of pr;
  if v_import_run is null or v_profile is null then raise exception 'parsehub_import_not_ready'; end if;
  if not v_auto then return jsonb_build_object('automaticCommit',false); end if;
  if v_actor is null then raise exception 'parsehub_profile_actor_missing'; end if;
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  v_result:=public.process_import_run(v_import_run);
  return coalesce(v_result,'{}'::jsonb)||jsonb_build_object('automaticCommit',true);
end $$;

revoke all on function public.claim_parsehub_runs(text,integer) from public,anon,authenticated;
revoke all on function public.process_parsehub_import_run(uuid) from public,anon,authenticated;
grant execute on function public.claim_parsehub_runs(text,integer),public.process_parsehub_import_run(uuid) to service_role;

commit;
