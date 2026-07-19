begin;

-- Prestanda, scraperdrift och jobbkontroller.
--
-- 1. Aggregerande RPC:er så att dashboard och listvyer slutar hämta obegränsade
--    rådatamängder till Node för att räkna i minnet.
-- 2. Kvotreservation för ingestionkörningar (per källa, atomisk, fönsterbaserad).
-- 3. Administrativa jobbkontroller: pausa, återuppta, avbryt och kör om
--    dead-letter-körningar med bevarad checkpoint.
-- 4. Schemaläggar- och claimfixar: en terminalt misslyckad körning får inte
--    återclaimas, och samma jobb får aldrig ha två öppna körningar samtidigt.
-- 5. Index som matchar dialerns, dashboardens och köernas verkliga querymönster.

-- ---------------------------------------------------------------------------
-- 1. Aggregerande läs-RPC:er. security invoker: RLS förblir sanningskällan.
-- ---------------------------------------------------------------------------

create or replace function public.dashboard_overview()
returns jsonb language sql stable security invoker set search_path=public as $$
  select jsonb_build_object(
    'customers',(select count(*) from public.customers where deleted_at is null),
    'callsToday',(select count(*) from public.calls where created_at>=date_trunc('day',now())),
    'pendingContracts',(select count(*) from public.contracts where status in ('sent','delivered','opened','signing')),
    'openActivities',(select count(*) from public.activities where status='open'),
    'openDeals',(select count(*) from public.deals where status='open'),
    'wonDealValue',(select coalesce(sum(value),0) from public.deals where status='won')
  )
$$;

create or replace function public.customer_list_overview(p_list_id uuid default null)
returns table(list_id uuid,total_members bigint,open_members bigint,active_sellers bigint)
language sql stable security invoker set search_path=public as $$
  select l.id,
    count(m.customer_id),
    count(m.customer_id) filter (where m.state not in ('completed','blocked')),
    (select count(*) from public.customer_list_seller_assignments a where a.list_id=l.id and a.status='active')
  from public.customer_lists l
  left join public.customer_list_members m on m.list_id=l.id
  where p_list_id is null or l.id=p_list_id
  group by l.id
$$;

create or replace function public.customer_list_candidate_counts(p_list_id uuid)
returns jsonb language sql stable security invoker set search_path=public as $$
  select jsonb_build_object(
    'approved',count(*) filter (where status='approved'),
    'pendingNix',count(*) filter (where status='pending_nix'),
    'blocked',count(*) filter (where status='blocked'),
    'pending',count(*) filter (where status='pending')
  ) from public.customer_list_contact_candidates where list_id=p_list_id
$$;

grant execute on function public.dashboard_overview(),public.customer_list_overview(uuid),public.customer_list_candidate_counts(uuid) to authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 2. Atomisk kvotreservation för ingestion. En enhet motsvarar ett externt
--    anrop (en sidhämtning). Samma provider_rate_limits/-usage_counters som
--    berikningen använder, med separat quota_key 'ingestion' när sådan finns.
-- ---------------------------------------------------------------------------

create or replace function public.reserve_provider_ingestion_usage(p_run_id uuid,p_units integer default 1)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_run public.ingestion_runs%rowtype; v_job public.ingestion_jobs%rowtype;
  v_rate public.provider_rate_limits%rowtype; v_window timestamptz; v_used integer;
  v_units integer:=greatest(1,coalesce(p_units,1));
begin
  select * into v_run from public.ingestion_runs where id=p_run_id;
  if not found then raise exception 'ingestion_run_not_found'; end if;
  select * into v_job from public.ingestion_jobs where id=v_run.ingestion_job_id;
  if v_job.provider_account_id is null then return jsonb_build_object('allowed',true,'limited',false); end if;
  select * into v_rate from public.provider_rate_limits
    where tenant_id=v_job.tenant_id and provider_account_id=v_job.provider_account_id
    order by case when quota_key='ingestion' then 0 when quota_key='enrichment' then 1 else 2 end,created_at
    limit 1;
  if v_rate.id is null then return jsonb_build_object('allowed',true,'limited',false); end if;
  v_window:=to_timestamp(floor(extract(epoch from now())/v_rate.window_seconds)*v_rate.window_seconds);
  insert into public.provider_usage_counters(tenant_id,provider_account_id,quota_key,window_started_at,used_units)
    values(v_job.tenant_id,v_job.provider_account_id,v_rate.quota_key,v_window,0)
  on conflict(provider_account_id,quota_key,window_started_at) do nothing;
  select used_units into v_used from public.provider_usage_counters
    where provider_account_id=v_job.provider_account_id and quota_key=v_rate.quota_key and window_started_at=v_window
    for update;
  if v_used+v_units>v_rate.max_units then
    return jsonb_build_object(
      'allowed',false,'limited',true,
      'retryAfterSeconds',greatest(1,ceil(extract(epoch from (v_window+make_interval(secs=>v_rate.window_seconds)-now())))::integer),
      'minimumDelayMs',v_rate.minimum_delay_ms
    );
  end if;
  update public.provider_usage_counters set used_units=used_units+v_units,updated_at=now()
    where provider_account_id=v_job.provider_account_id and quota_key=v_rate.quota_key and window_started_at=v_window;
  return jsonb_build_object(
    'allowed',true,'limited',true,
    'remainingUnits',v_rate.max_units-v_used-v_units,
    'minimumDelayMs',v_rate.minimum_delay_ms,'timeoutMs',v_rate.timeout_ms
  );
end $$;

revoke all on function public.reserve_provider_ingestion_usage(uuid,integer) from public,anon,authenticated;
grant execute on function public.reserve_provider_ingestion_usage(uuid,integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Administrativa jobbkontroller. En terminalt misslyckad körning
--    (status=failed och completed_at satt) är systemets dead letter: den kan
--    köras om med bevarad checkpoint via 'resume'.
-- ---------------------------------------------------------------------------

create or replace function public.control_ingestion_run(p_run_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_run public.ingestion_runs%rowtype; v_tenant uuid:=public.current_tenant_id();
begin
  if v_tenant is null or not public.is_tenant_admin(v_tenant) then raise exception 'admin_required'; end if;
  if p_action not in ('pause','resume','cancel') then raise exception 'invalid_ingestion_run_action'; end if;
  select * into v_run from public.ingestion_runs where id=p_run_id and tenant_id=v_tenant for update;
  if not found then raise exception 'ingestion_run_not_found'; end if;
  if p_action='pause' then
    if v_run.status not in ('scheduled','running') then raise exception 'ingestion_run_not_pausable'; end if;
    update public.ingestion_runs set status='paused',locked_at=null,locked_by=null where id=p_run_id;
  elsif p_action='resume' then
    if v_run.status not in ('paused','failed') then raise exception 'ingestion_run_not_resumable'; end if;
    update public.ingestion_runs set status='scheduled',attempts=0,next_attempt_at=now(),completed_at=null,locked_at=null,locked_by=null where id=p_run_id;
  else
    if v_run.status in ('completed','cancelled') then raise exception 'ingestion_run_already_finished'; end if;
    update public.ingestion_runs set status='cancelled',completed_at=now(),locked_at=null,locked_by=null where id=p_run_id;
    update public.crawl_plans set status='skipped' where ingestion_run_id=p_run_id and status in ('pending','running');
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,auth.uid(),'ingestion_run.'||p_action,'ingestion_run',p_run_id::text,
    jsonb_build_object('previousStatus',v_run.status,'attempts',v_run.attempts,'checkpointPage',v_run.current_page));
  return jsonb_build_object('runId',p_run_id,'action',p_action,'previousStatus',v_run.status);
end $$;

grant execute on function public.control_ingestion_run(uuid,text) to authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 4. Schemaläggar- och claimfixar.
--    a) Schemaläggaren skapade nya körningar medan en retry-bar misslyckad
--       körning fortfarande väntade, vilket kunde ge dubbelarbete mot källan.
--    b) claim_ingestion_runs kunde återclaima terminalt misslyckade körningar
--       eftersom completed_at aldrig kontrollerades.
--    c) Ett partiellt unikt index garanterar en öppen körning per jobb.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_due_ingestion_jobs(p_limit integer default 20)
returns setof public.ingestion_runs language plpgsql security definer set search_path=public as $$
declare j public.ingestion_jobs%rowtype; r public.ingestion_runs%rowtype; v_parser uuid;
begin
  for j in select * from public.ingestion_jobs where status='active' and coalesce(next_run_at,now())<=now()
    and not exists(
      select 1 from public.ingestion_runs ir where ir.ingestion_job_id=ingestion_jobs.id
        and (ir.status in ('scheduled','running','paused') or (ir.status='failed' and ir.completed_at is null))
    )
    order by priority,next_run_at nulls first limit greatest(1,least(p_limit,100)) for update skip locked
  loop
    if not exists(select 1 from public.provider_permissions pp where pp.id=j.permission_id and pp.status='active' and (pp.starts_at is null or pp.starts_at<=now()) and (pp.expires_at is null or pp.expires_at>now())) then
      update public.ingestion_jobs set status='paused',updated_at=now() where id=j.id; continue;
    end if;
    select id into v_parser from public.parser_versions where tenant_id=j.tenant_id and data_provider_id=j.data_provider_id and entity_type=j.entity_type and status='active' order by created_at desc limit 1;
    insert into public.ingestion_runs(tenant_id,ingestion_job_id,parser_version_id,status,requested_records,max_attempts,next_attempt_at,metadata)
    values(j.tenant_id,j.id,v_parser,'scheduled',j.max_records,coalesce((j.adapter_configuration->>'max_retries')::integer,5),now(),jsonb_build_object('adapter_key',j.adapter_key)) returning * into r;
    insert into public.crawl_plans(tenant_id,ingestion_run_id,priority_bucket,filter_definition,sort_order)
    select j.tenant_id,r.id,x.bucket,j.filter_definition||jsonb_build_object('priorityBucket',x.bucket),x.bucket from (values(1),(2),(3),(4)) x(bucket);
    insert into public.crawl_checkpoints(tenant_id,ingestion_run_id,last_filter,remaining_capacity,last_successful_step)
    values(j.tenant_id,r.id,j.filter_definition,j.max_records,'scheduled');
    update public.ingestion_jobs set last_scheduled_at=now(),next_run_at=now()+make_interval(secs=>schedule_interval_seconds),updated_at=now() where id=j.id;
    return next r;
  end loop;
end $$;

create or replace function public.claim_ingestion_runs(p_worker text,p_limit integer default 5)
returns setof public.ingestion_runs language plpgsql security definer set search_path=public as $$
begin
  return query with picked as (
    select id from public.ingestion_runs
    where status in ('scheduled','failed') and completed_at is null and next_attempt_at<=now()
      and (locked_at is null or locked_at<now()-interval '15 minutes') and attempts<max_attempts
    order by created_at limit greatest(1,least(p_limit,25)) for update skip locked
  ) update public.ingestion_runs ir set status='running',locked_at=now(),locked_by=left(p_worker,200),attempts=attempts+1,started_at=coalesce(started_at,now()) from picked where ir.id=picked.id returning ir.*;
end $$;

-- Städa eventuella historiska dubbletter innan det unika indexet skapas.
update public.ingestion_runs ir set status='cancelled',completed_at=now(),locked_at=null,locked_by=null,last_error='superseded_duplicate_open_run'
where ir.status in ('scheduled','running','paused')
  and exists(
    select 1 from public.ingestion_runs newer
    where newer.ingestion_job_id=ir.ingestion_job_id and newer.id<>ir.id
      and newer.status in ('scheduled','running','paused')
      and (newer.created_at>ir.created_at or (newer.created_at=ir.created_at and newer.id>ir.id))
  );

create unique index if not exists ingestion_runs_one_open_per_job_idx
  on public.ingestion_runs(ingestion_job_id)
  where status in ('scheduled','running','paused');

-- ---------------------------------------------------------------------------
-- 5. Index som matchar verkliga querymönster.
-- ---------------------------------------------------------------------------

-- Dialerns dagliga kapacitetskontroll räknar samtal per lista/säljare/dag.
create index if not exists calls_list_capacity_idx on public.calls(tenant_id,list_id,user_id,created_at) where list_id is not null;
-- Återkomstclaimen sorterar på coalesce(snoozed_until,due_at); tidigare index täckte bara due_at.
create index if not exists activities_callback_pick_idx on public.activities(tenant_id,list_id,status,(coalesce(snoozed_until,due_at))) where type='callback';
-- Dashboardens affärsaggregat.
create index if not exists deals_tenant_status_value_idx on public.deals(tenant_id,status,value);
-- Kund- och företagslistornas paginering.
create index if not exists customers_tenant_created_idx on public.customers(tenant_id,created_at desc) where deleted_at is null;
create index if not exists customers_tenant_type_name_idx on public.customers(tenant_id,customer_type,display_name) where deleted_at is null;
-- Worker-köernas claimmönster.
create index if not exists ingestion_runs_claimable_idx on public.ingestion_runs(next_attempt_at,created_at) where status in ('scheduled','failed') and completed_at is null;
create index if not exists enrichment_jobs_claimable_idx on public.enrichment_jobs(next_attempt_at,created_at) where status='queued';

commit;
