-- Say which list stopped refreshing, and why.
--
-- `refresh_due_dynamic_customer_lists` walks every dynamic list whose segment has
-- moved on and re-materialises it. A list that fails is counted and the reason is
-- thrown away: the function returns `{"completed": 8, "failed": 3}` and `sqlerrm`
-- is discarded inside the handler.
--
-- Catching per list is right — one bad list must not stop the other seven. What
-- was wrong is that the only trace of a failure is a number. The caller is
-- `maintenance-worker`, which puts the count in its heartbeat, so a dynamic list
-- that has silently stopped refreshing looks exactly like one that was never due.
-- Sellers keep working a prospect list that stopped being updated, and nothing
-- anywhere says which one or what went wrong.
--
-- The failures now come back with the list id and the message, so the worker
-- response and the heartbeat carry something actionable. Nothing else changes:
-- the same lists are selected, the same ones are attempted, the same ones
-- succeed.
create or replace function public.refresh_due_dynamic_customer_lists(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_list record;
  v_previous_sub text := current_setting('request.jwt.claim.sub', true);
  v_completed integer := 0;
  v_failed integer := 0;
  v_failures jsonb := '[]'::jsonb;
begin
  for v_list in
    select l.id,l.owner_user_id,(l.filter_definition->>'segmentId')::uuid segment_id
    from public.customer_lists l join public.segments s on s.tenant_id=l.tenant_id and s.id=(l.filter_definition->>'segmentId')::uuid
    where l.list_type='dynamic' and l.status='active' and l.filter_definition->>'source'='segment' and s.active
      and coalesce((l.filter_definition->>'syncedAt')::timestamptz,'epoch'::timestamptz)<coalesce(s.last_refreshed_at,now())
      and l.owner_user_id is not null and exists(
        select 1 from public.tenant_memberships m where m.tenant_id=l.tenant_id and m.user_id=l.owner_user_id and m.status='active'
      )
    order by s.last_refreshed_at nulls first,l.updated_at limit greatest(1,least(p_limit,500))
  loop
    begin
      perform set_config('request.jwt.claim.sub',v_list.owner_user_id::text,true);
      perform public.materialize_segment_to_customer_list(v_list.segment_id,v_list.id);
      v_completed:=v_completed+1;
    exception when others then
      v_failed:=v_failed+1;
      -- Bounded so one repeatedly failing run cannot return an unbounded payload.
      if jsonb_array_length(v_failures) < 20 then
        v_failures := v_failures || jsonb_build_object(
          'list_id', v_list.id,
          'segment_id', v_list.segment_id,
          'error', left(sqlerrm, 300)
        );
      end if;
    end;
  end loop;
  perform set_config('request.jwt.claim.sub',coalesce(v_previous_sub,''),true);
  return jsonb_build_object('completed',v_completed,'failed',v_failed,'failures',v_failures);
end $function$;
