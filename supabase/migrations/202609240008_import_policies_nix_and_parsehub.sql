begin;

-- Importens rester efter PR F (FAILURE-0129, FAILURE-0130).

-- 1. Backoffice får mappa om en import. `permissions.ts`, RLS och
--    `process_import_run` släpper redan in rollen, men ommappningen nekade den.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  if not public.has_current_role(array['owner','admin','team_lead']) then raise exception 'import_manage_permission_required'; end if;$a$;
begin
  select pg_get_functiondef('public.apply_import_row_normalization(uuid,jsonb)'::regprocedure) into v_definition;
  if position('backoffice_may_remap' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'apply_import_row_normalization_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$  -- backoffice_may_remap
  if not public.has_current_role(array['owner','admin','team_lead','backoffice']) then raise exception 'import_manage_permission_required'; end if;$r$);
end
$migration$;

-- 2. Importprofilens sammanslagningsregel följs.
--    "Skapa endast nya" ändrar inte en befintlig kund; "Granska konflikter"
--    lägger varje träff på en befintlig kund i konfliktlistan i stället för att
--    skriva över den. Båda ignorerades: varje befintlig kund uppdaterades.
do $migration$
declare
  v_definition text;
  v_before constant text := $a$      select to_jsonb(c.*) into v_before from public.customers c where c.tenant_id=v_tenant and c.id=v_customer_id for update;$a$;
  v_after constant text := $a$ returning to_jsonb(c.*) into v_after;$a$;
begin
  select pg_get_functiondef('public.process_import_run(uuid)'::regprocedure) into v_definition;
  if position('merge_policy_honoured' in v_definition) > 0 then return; end if;
  if position(v_before in v_definition) = 0 then raise exception 'process_import_run_merge_before_anchor_missing'; end if;
  if position(v_after in v_definition) = 0 then raise exception 'process_import_run_merge_after_anchor_missing'; end if;
  v_definition := replace(v_definition, v_before, v_before || $r$
      -- merge_policy_honoured
      if coalesce(v_data->>'merge_policy','safe_upsert')='review_conflicts' then
        insert into public.import_merge_conflicts(tenant_id,import_run_id,import_row_id,reason,incoming_value)
        values(v_tenant,p_import_run_id,v_row.id,'existing_customer_requires_review',v_data);
        update public.import_rows set decision='conflict',row_status='conflict',error_code='existing_customer_requires_review',
          processing_ms=(extract(epoch from clock_timestamp()-v_started)*1000)::integer where id=v_row.id;
        v_conflicts:=v_conflicts+1;
        continue;
      end if;
      if coalesce(v_data->>'merge_policy','safe_upsert')='create_only' then
        v_after:=v_before;
      else$r$);
  v_definition := replace(v_definition, v_after, v_after || $r$
      end if;$r$);
  execute v_definition;
end
$migration$;

-- 3. Ett prospekt som väntade på NIX släpps i kön när kontrollen gått igenom.
--    Importen lägger platsen som `blocked` med `pending_nix`. När kontrollen
--    passerade försökte funktionen skapa platsen igen (`on conflict do nothing`),
--    så den blev liggande spärrad för alltid.
do $migration$
declare
  v_definition text;
  v_pass constant text := $a$      values(j.tenant_id,candidate.list_id,j.customer_id,candidate.segment_id,j.requested_by) on conflict(list_id,customer_id) do nothing;$a$;
  v_fail constant text := $a$      update public.customer_list_contact_candidates set status='blocked',policy_reason=policy->>'reason',evaluated_at=now() where list_id=candidate.list_id and customer_id=j.customer_id;$a$;
begin
  select pg_get_functiondef('public.complete_nix_check_job(uuid,text,text,jsonb)'::regprocedure) into v_definition;
  if position('nix_pass_unblocks_list_place' in v_definition) > 0 then return; end if;
  if position(v_pass in v_definition) = 0 or position(v_fail in v_definition) = 0 then raise exception 'complete_nix_check_job_anchor_missing'; end if;
  v_definition := replace(v_definition, v_pass, v_pass || $r$
      -- nix_pass_unblocks_list_place
      update public.customer_list_members set state='pending',compliance_status='eligible',compliance_reason='allowed',updated_at=now()
        where tenant_id=j.tenant_id and list_id=candidate.list_id and customer_id=j.customer_id
          and state='blocked' and compliance_status='pending_nix';$r$);
  v_definition := replace(v_definition, v_fail, v_fail || $r$
      update public.customer_list_members set compliance_status='blocked',compliance_reason=policy->>'reason',updated_at=now()
        where tenant_id=j.tenant_id and list_id=candidate.list_id and customer_id=j.customer_id and compliance_status='pending_nix';$r$);
  execute v_definition;
end
$migration$;

-- 4. En ParseHub-körning som felat permanent körs inte om varje minut.
--    Arbetaren sätter `failed` bara för fel som inte går att försöka igen; ett
--    fel som går att försöka igen blir `queued` med `next_attempt_at`.
create or replace function public.claim_parsehub_runs(p_worker text,p_limit integer default 5)
returns setof public.parsehub_runs
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(nullif(trim(p_worker),''),'')='' then raise exception 'worker_required'; end if;
  return query
  with candidates as (
    select id
    from public.parsehub_runs
    where status='queued'
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

-- 5. Död kod: funktionen anropar en funktion från den tidigare telefonileverantören,
--    borttagen i 202609170009, och ingen trigger använder den. Borttagnings-
--    migrationens egen kontroll såg bara funktionsnamn, inte funktionskroppar.
drop function if exists public.keep_terminal_dial_attempt_terminal();

commit;
