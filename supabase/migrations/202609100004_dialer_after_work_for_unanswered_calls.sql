begin;

-- FAILURE-0051 — after-work was impossible on every call nobody answered.
--
-- `complete_dialer_work` accepts a finished call only in
-- ('completed','busy','no_answer','failed','cancelled'). Rinkel's projection never writes
-- three of the statuses it produces into that set: `mapRinkelCauseToCallStatus` returns
-- `unanswered` for UNANSWERED, `voicemail` for VOICEMAIL, `blocked` for BLACKLISTED and
-- `outside_business_hours` for OUTSIDE_OPERATION_TIMES.
--
-- `complete_dialer_work_v2` tried to bridge that by rewriting `calls.status` to an accepted
-- value, delegating, and rewriting it back. That bridge cannot work: `call_status_rank`
-- gives every terminal status rank 100, and `protect_rinkel_call_projection` silently
-- reverts any change between two rank-100 statuses — by design, so a late provider event
-- cannot rewrite a settled outcome. The bridging UPDATE was therefore a no-op, the
-- delegated function still saw `unanswered`, and after-work raised `call_not_finished`.
--
-- The effect on the seller: a list call that rang out, hit voicemail or was refused could
-- not be given an outcome at all. "Inget svar", "Telefonsvarare" and "Ring inte igen" were
-- unreachable on exactly the calls that need them, the prospect stayed claimed until the
-- claim expired, and an automatic dialer could not advance past the first unanswered call.
--
-- Fix the gate rather than the status: a call is finished when its status is terminal.
-- The projection stays the single source of truth for what happened on the line, and
-- nothing rewrites it.

-- The canonical set, matching `call_status_rank(...)=100` and the worker's
-- `isTerminalCallStatus`. Kept as a function so the gate and any future caller share one
-- definition instead of a third hand-written list.
create or replace function public.is_terminal_call_status(p_status text)
returns boolean
language sql
immutable
set search_path=''
as $$
  select public.call_status_rank(p_status)=100
$$;
revoke all on function public.is_terminal_call_status(text) from public,anon;
grant execute on function public.is_terminal_call_status(text) to authenticated,service_role;

-- Patched textually from the live definition so every delivered change to the dialer
-- completion — order creation, callback projection, list state and retry scheduling —
-- is preserved verbatim.
do $migration$
declare
  v_definition text;
  v_anchor text:=$needle$  if v_call.status not in ('completed','busy','no_answer','failed','cancelled') or v_call.ended_at is null then raise exception 'call_not_finished'; end if;$needle$;
begin
  select pg_get_functiondef('public.complete_dialer_work(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text)'::regprocedure)
  into v_definition;
  if position(v_anchor in v_definition)=0 then
    raise exception 'complete_dialer_work_finished_gate_anchor_missing';
  end if;
  v_definition:=replace(
    v_definition,
    v_anchor,
    $replacement$  if not public.is_terminal_call_status(v_call.status) or v_call.ended_at is null then raise exception 'call_not_finished'; end if;$replacement$
  );
  execute v_definition;
end
$migration$;

revoke all on function public.complete_dialer_work(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text) from public,anon;
grant execute on function public.complete_dialer_work(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text) to authenticated;

-- With the gate fixed, the Rinkel branch is a plain terminal-status check. The status
-- rewriting is gone: it never took effect, and while it appeared to work it made the
-- function briefly claim an outcome the provider had not reported.
create or replace function public.complete_dialer_work_v2(
  p_call_id uuid,p_disposition_key text,p_notes text,p_callback_scope text,p_callback_due_at timestamptz,
  p_create_order boolean,p_product_id uuid,p_quantity numeric,p_unit_price numeric,p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_status text;
begin
  select status into v_status from public.calls
    where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found then raise exception 'list_call_not_found'; end if;
  if not public.is_terminal_call_status(v_status) then raise exception 'call_not_finished'; end if;
  return public.complete_dialer_work(
    p_call_id,p_disposition_key,p_notes,p_callback_scope,p_callback_due_at,
    p_create_order,p_product_id,p_quantity,p_unit_price,p_idempotency_key
  );
end $$;
revoke all on function public.complete_dialer_work_v2(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text) from public,anon;
grant execute on function public.complete_dialer_work_v2(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text) to authenticated;

-- The manual (non-list) after-work path has the same provider statuses to handle.
do $migration$
declare
  v_definition text;
  v_anchor text:=$needle$    if v_status not in ('completed','unanswered','failed','blocked','voicemail','outside_business_hours','cancelled') then$needle$;
begin
  select pg_get_functiondef('public.complete_manual_call_work_v2(uuid,text,text,text,timestamptz)'::regprocedure)
  into v_definition;
  if position(v_anchor in v_definition)=0 then
    -- Already terminal-status based, or shaped differently; nothing to patch.
    return;
  end if;
  v_definition:=replace(
    v_definition,
    v_anchor,
    $replacement$    if not public.is_terminal_call_status(v_status) then$replacement$
  );
  execute v_definition;
end
$migration$;

commit;
