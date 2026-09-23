begin;

-- Varje samtals utfall hamnar rätt.
--
-- Genomgången 2026-09-23 hittade sju ställen där ett samtal fick fel utfall,
-- inget utfall, eller låste säljaren. Varje block nedan säger vilket.
-- Funktionerna ändras genom att ersätta en exakt textbit i den levererade
-- definitionen; saknas biten avbryts migrationen i stället för att gissa.

-- 1. Leverantörens "misslyckat" får ersätta webbläsarens "inget svar".
--
-- Webbläsarens avslutsrapport kommer oftast före DiCE. Den sa `unanswered` även
-- när Sinch bröt samtalet, och projektionsspärren fryser varje avslutad status,
-- så leverantörens `failed` kom aldrig fram. Exakt det bytet släpps igenom, och
-- bara när DiCE-hanteringen har markerat transaktionen som leverantörens.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  if public.call_status_rank(old.status)=100 and new.status<>old.status then$a$;
begin
  select pg_get_functiondef('public.protect_call_projection()'::regprocedure) into v_definition;
  if position('kundexa.provider_authoritative' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'protect_call_projection_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$  if old.status='unanswered' and new.status='failed' and old.answered_at is null
    and coalesce(current_setting('kundexa.provider_authoritative', true),'')='on' then
    return new;
  end if;

$r$ || v_anchor);
end
$migration$;

do $migration$
declare
  v_definition text;
  v_dice constant text := $a$  if p_event = 'dice' then
    v_reason := upper(coalesce(p_payload->>'reason', 'N/A'));$a$;
  v_where constant text := $a$    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id
      and public.call_status_rank(c.status) < public.call_status_rank(v_call_status);$a$;
begin
  select pg_get_functiondef('public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz)'::regprocedure)
    into v_definition;
  if position('kundexa.provider_authoritative' in v_definition) > 0 then return; end if;
  if position(v_dice in v_definition) = 0 or position(v_where in v_definition) = 0 then
    raise exception 'ingest_sinch_voice_event_dice_anchor_missing';
  end if;
  v_definition := replace(v_definition, v_dice, v_dice || $r$
    perform set_config('kundexa.provider_authoritative', 'on', true);$r$);
  v_definition := replace(v_definition, v_where, $r$    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id
      and (public.call_status_rank(c.status) < public.call_status_rank(v_call_status)
        or (c.status = 'unanswered' and v_call_status = 'failed' and c.answered_at is null));

    -- Samma slutstatus som webbläsaren redan satt: leverantörens längd och
    -- orsak är de riktiga och ersätter klientens uppskattning.
    update public.calls c
    set duration_seconds = coalesce((p_payload->>'duration')::integer, c.duration_seconds),
        end_cause = case when c.end_cause is null or c.end_cause = 'webphone_leg_ended' then lower(v_reason) else c.end_cause end,
        updated_at = now()
    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id and c.status = v_call_status;$r$);
  execute v_definition;
end
$migration$;

-- 2. Ett besvarat samtal som avslutas i webbläsaren blir avslutat.
--
-- Rapporten släppte bara platsen och lämnade samtalet `answered`. Kom ingen
-- DiCE stod säljaren kvar på "pågår" och samtalet fick aldrig något utfall.
-- Nu sätts `completed` med längd från svarstiden; DiCE ersätter längden.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$    if v_rank < 40 then
      update public.calls
         set status = case when p_event = 'failed' then 'failed' else 'unanswered' end,$a$;
begin
  select pg_get_functiondef('public.record_webphone_leg_event(uuid,uuid,text,timestamptz)'::regprocedure)
    into v_definition;
  if position('answered_call_closed_by_client' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'record_webphone_leg_event_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$    -- answered_call_closed_by_client
    if v_rank = 40 then
      update public.calls
         set status = 'completed',
             ended_at = coalesce(ended_at, v_occurred),
             duration_seconds = coalesce(duration_seconds,
               greatest(0, extract(epoch from (v_occurred - coalesce(answered_at, v_occurred))))::integer),
             end_cause = coalesce(end_cause, 'webphone_leg_ended'), updated_at = now()
       where tenant_id = v_tenant and id = v_call.id;
      v_advanced := 'completed';
    end if;
$r$ || v_anchor);
end
$migration$;

-- 3. En sen "accepterat"-rapport får inte låsa säljaren igen.
--
-- `finalize_dial` skrev över försöket oavsett status. Kom webbläsarens
-- avslutsrapport först och "accepterat" efter, gick ett avslutat försök tillbaka
-- till `dial_requested` och höll platsen i 15 minuter. Nu uppdateras bara ett
-- försök som fortfarande håller platsen och som tillhör den som anropar.
create or replace function public.finalize_dial(
  p_call_id uuid, p_attempt_id uuid, p_outcome text,
  p_external_call_id text default null, p_error_code text default null, p_error_message text default null
)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_attempt_status text;
  v_call_status text;
  v_current text;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if p_outcome not in ('accepted','failed','unknown') then raise exception 'finalize_outcome_invalid'; end if;

  v_attempt_status := case p_outcome
    when 'accepted' then 'dial_requested'
    when 'failed' then 'failed'
    else 'provider_outcome_unknown' end;
  v_call_status := v_attempt_status;

  update public.dial_attempts a
  set status = v_attempt_status,
      external_call_id = coalesce(p_external_call_id, a.external_call_id),
      provider_request_finished_at = now(),
      error_code = coalesce(p_error_code, a.error_code),
      error_message = left(coalesce(p_error_message, a.error_message), 500),
      updated_at = now()
  where a.id = p_attempt_id and a.tenant_id = v_tenant and a.call_id = p_call_id
    and a.seller_user_id = v_user
    and public.dial_attempt_holds_seat(a.status);

  if not found then
    select a.status into v_current from public.dial_attempts a
      where a.id = p_attempt_id and a.tenant_id = v_tenant and a.call_id = p_call_id and a.seller_user_id = v_user;
    if not found then raise exception 'dial_attempt_not_found'; end if;
    -- Redan avgjort. Samtals-id:t behålls, men statusen rörs inte.
    update public.dial_attempts set external_call_id = coalesce(external_call_id, p_external_call_id), updated_at = now()
      where id = p_attempt_id and tenant_id = v_tenant;
    update public.calls set provider_call_id = coalesce(provider_call_id, p_external_call_id), updated_at = now()
      where id = p_call_id and tenant_id = v_tenant;
    return jsonb_build_object('callId', p_call_id, 'attemptId', p_attempt_id,
      'attemptStatus', v_current, 'alreadySettled', true);
  end if;

  update public.calls c
  set status = v_call_status,
      provider_status = case p_outcome when 'accepted' then 'requested' when 'failed' then 'failed' else 'unknown' end,
      provider_call_id = coalesce(p_external_call_id, c.provider_call_id),
      ended_at = case when p_outcome = 'failed' then coalesce(c.ended_at, now()) else c.ended_at end,
      updated_at = now()
  where c.id = p_call_id and c.tenant_id = v_tenant
    and public.call_status_rank(c.status) < 30;

  insert into public.call_events(tenant_id, call_id, event_type, payload)
  values(v_tenant, p_call_id, 'call.dial_finalized', jsonb_build_object(
    'attempt_id', p_attempt_id, 'outcome', p_outcome, 'error_code', p_error_code));

  return jsonb_build_object('callId', p_call_id, 'attemptId', p_attempt_id,
    'status', v_call_status, 'attemptStatus', v_attempt_status);
end $$;

-- 4. "Hoppa över" ger nästa prospekt, inte samma igen.
--
-- Hoppade medlemmar räknas som lediga och sorteras på prioritet och
-- `next_attempt_at`, som inte ändrades. Samma prospekt kom tillbaka direkt.
create or replace function public.release_list_member_claim(p_session_id uuid, p_reason text default 'paused')
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_member uuid; v_callback uuid; v_list uuid; v_allow_skip boolean;
begin
  select current_list_member_id,current_callback_activity_id,list_id into v_member,v_callback,v_list
    from public.dialer_sessions where tenant_id=v_tenant and id=p_session_id and user_id=v_user and state<>'ended' for update;
  if not found then raise exception 'dialer_session_not_found'; end if;
  select allow_skip into v_allow_skip from public.customer_lists where tenant_id=v_tenant and id=v_list;
  if p_reason='skip' and not coalesce(v_allow_skip,false) then raise exception 'list_skip_disabled'; end if;
  update public.customer_list_members set state=case when p_reason='skip' then 'skipped' else 'pending' end,claimed_by=null,claim_expires_at=null,
    next_attempt_at=case when p_reason='skip' then now()+interval '10 minutes' else next_attempt_at end,updated_at=now()
    where tenant_id=v_tenant and id=v_member and claimed_by=v_user;
  update public.activities set status='open',claimed_by=null,claim_expires_at=null,updated_at=now()
    where tenant_id=v_tenant and id=v_callback and claimed_by=v_user and status='in_progress';
  update public.dialer_sessions set state=case when p_reason='end' then 'ended' else 'paused' end,
    current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,
    paused_at=case when p_reason<>'end' then now() else paused_at end,ended_at=case when p_reason='end' then now() else ended_at end,last_seen_at=now()
    where id=p_session_id;
end $$;

-- 5. Nya listor får NIX-utfallet och kan leda till avtal.
--
-- `nix_listed` fanns i den manuella dialern men inte bland listans utfall, och
-- `contract_eligible` sattes aldrig för nya listor: "Spara och skapa avtal"
-- visades inte och databasen vägrade avtal från listsamtal.
create or replace function public.seed_list_dispositions(p_tenant uuid, p_list uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  insert into public.list_dispositions(tenant_id,list_id,key,label,outcome_group,terminal,retry_after_minutes,requires_note,requires_callback,requires_order,sort_order,contract_eligible) values
    (p_tenant,p_list,'interested','Intresserad','positive',true,null,false,false,false,10,true),
    (p_tenant,p_list,'order','Order skapad','positive',true,null,false,false,true,20,true),
    (p_tenant,p_list,'callback','Återkomst bokad','neutral',false,null,true,true,false,30,false),
    (p_tenant,p_list,'no_answer','Inget svar','unreachable',false,1440,false,false,false,40,false),
    (p_tenant,p_list,'busy','Upptaget','unreachable',false,120,false,false,false,50,false),
    (p_tenant,p_list,'voicemail','Telefonsvarare','unreachable',false,1440,false,false,false,60,false),
    (p_tenant,p_list,'not_interested','Inte intresserad','negative',true,null,false,false,false,70,false),
    (p_tenant,p_list,'wrong_number','Fel nummer','negative',true,null,true,false,false,80,false),
    (p_tenant,p_list,'do_not_call','Ring inte igen','blocked',true,null,true,false,false,90,false),
    (p_tenant,p_list,'nix_listed','NIX-registrerad','blocked',true,null,false,false,false,95,false)
  on conflict(list_id,key) do nothing;
end $$;

insert into public.list_dispositions(tenant_id,list_id,key,label,outcome_group,terminal,retry_after_minutes,requires_note,requires_callback,requires_order,sort_order,contract_eligible)
select l.tenant_id,l.id,'nix_listed','NIX-registrerad','blocked',true,null,false,false,false,95,false
from public.customer_lists l
on conflict(list_id,key) do nothing;

update public.list_dispositions set contract_eligible=true
where key in ('interested','order') and not coalesce(contract_eligible,false);

-- 6. Ett manuellt utfall gäller också kundens listor.
--
-- "Inte intresserad" från kundkortet lämnade kunden i kö på varje lista, och
-- nästa säljare ringde upp. Öppna, icke låsta platser stängs med samma utfall.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'manual_call.after_work_completed'$a$;
begin
  select pg_get_functiondef('public.complete_manual_call_work(uuid,text,text,text,timestamptz)'::regprocedure)
    into v_definition;
  if position('manual_outcome_closes_list_members' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'complete_manual_call_work_audit_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$  -- manual_outcome_closes_list_members
  if p_disposition in ('not_interested','wrong_number','do_not_call','nix_listed') then
    update public.customer_list_members
       set state = case when p_disposition in ('do_not_call','nix_listed') then 'blocked' else 'completed' end,
           outcome = p_disposition, completed_at = now(), next_attempt_at = null, updated_at = now()
     where tenant_id = v_tenant and customer_id = v_call.customer_id
       and state in ('pending','retry','skipped','callback') and claimed_by is null;
  end if;
$r$ || v_anchor);
end
$migration$;

-- 7. Listans utfall skriver inte över kundens nästa aktivitet.
--
-- Ett slututfall nollade en bokad återkomst på kundkortet, och "inget svar"
-- ersatte den med listans omförsökstid. Den tidigaste vinner, och inget
-- nytt datum lämnar det gamla orört.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  update public.customers set next_activity_at=v_next where tenant_id=v_tenant and id=v_call.customer_id;$a$;
begin
  select pg_get_functiondef('public.complete_dialer_work(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text)'::regprocedure)
    into v_definition;
  if position(v_anchor in v_definition) = 0 then
    if position('least(coalesce(next_activity_at,v_next),v_next)' in v_definition) > 0 then return; end if;
    raise exception 'complete_dialer_work_next_activity_anchor_missing';
  end if;
  execute replace(v_definition, v_anchor,
    $r$  if v_next is not null then
    update public.customers set next_activity_at=least(coalesce(next_activity_at,v_next),v_next) where tenant_id=v_tenant and id=v_call.customer_id;
  end if;$r$);
end
$migration$;

commit;
