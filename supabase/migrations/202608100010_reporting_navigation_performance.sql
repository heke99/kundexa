begin;

-- Query-driven indexes for the dashboard/report/list hot paths introduced below.
create index if not exists calls_tenant_list_created_idx
  on public.calls(tenant_id,list_id,created_at desc);
create index if not exists contracts_tenant_created_status_idx
  on public.contracts(tenant_id,created_at desc,status);
create index if not exists sales_orders_tenant_list_created_idx
  on public.sales_orders(tenant_id,source_list_id,created_at desc);
create index if not exists activities_tenant_callback_list_due_idx
  on public.activities(tenant_id,list_id,due_at)
  where type='callback';
create index if not exists customer_list_members_tenant_list_state_idx
  on public.customer_list_members(tenant_id,list_id,state);

-- Navigation badges are calculated in SQL so the app shell never downloads
-- hundreds of callback rows just to count them.
create or replace function public.navigation_badges()
returns jsonb
language sql
stable
security invoker
set search_path=public
as $$
  select jsonb_build_object(
    'dueCallbacks',(
      select count(*)::integer
      from public.activities a
      where a.type='callback'
        and a.status='open'
        and coalesce(a.snoozed_until,a.due_at)<=now()
    ),
    'activeLists',(
      select count(*)::integer
      from public.customer_lists l
      where l.status='active'
    )
  )
$$;
revoke all on function public.navigation_badges() from public,anon;
grant execute on function public.navigation_badges() to authenticated;

-- A single RLS-aware aggregate replaces downloading calls/contracts/list members
-- into Node merely to aggregate the last 30 days.
create or replace function public.report_sales_overview(
  p_since timestamptz default now()-interval '30 days'
) returns jsonb
language sql
stable
security invoker
set search_path=public
as $$
with
calls_window as (
  select id,list_id,disposition,duration_seconds
  from public.calls
  where created_at>=coalesce(p_since,now()-interval '30 days')
),
contracts_window as (
  select status
  from public.contracts
  where created_at>=coalesce(p_since,now()-interval '30 days')
),
call_totals as (
  select
    count(*)::integer attempts,
    count(*) filter(where disposition in ('interested','not_interested','callback','order','do_not_call'))::integer answered,
    coalesce(sum(duration_seconds),0)::bigint call_seconds
  from calls_window
),
contract_totals as (
  select
    count(*) filter(where status not in ('draft','ready'))::integer sent,
    count(*) filter(where status in ('signed','active'))::integer signed
  from contracts_window
),
calls_by_list as (
  select list_id,
    count(*)::integer attempts,
    count(*) filter(where disposition in ('interested','not_interested','callback','order','do_not_call'))::integer contacts
  from calls_window
  where list_id is not null
  group by list_id
),
orders_by_list as (
  select source_list_id list_id,count(*)::integer orders,coalesce(sum(total),0)::numeric revenue
  from public.sales_orders
  where created_at>=coalesce(p_since,now()-interval '30 days') and source_list_id is not null
  group by source_list_id
),
callbacks_by_list as (
  select list_id,count(*)::integer callbacks,
    count(*) filter(where status='completed' and handled_at is not null)::integer handled_callbacks
  from public.activities
  where type='callback' and created_at>=coalesce(p_since,now()-interval '30 days') and list_id is not null
  group by list_id
),
members_by_list as (
  select list_id,count(*) filter(where state not in ('completed','blocked'))::integer remaining
  from public.customer_list_members
  group by list_id
),
list_rows as (
  select l.id,l.name,l.status,l.dialing_mode,
    coalesce(c.attempts,0) attempts,
    case when coalesce(c.attempts,0)=0 then 0 else round(100.0*coalesce(c.contacts,0)/c.attempts)::integer end contact_rate,
    coalesce(o.orders,0) orders,coalesce(o.revenue,0) revenue,
    coalesce(cb.callbacks,0) callbacks,coalesce(cb.handled_callbacks,0) handled_callbacks,
    coalesce(m.remaining,0) remaining
  from public.customer_lists l
  left join calls_by_list c on c.list_id=l.id
  left join orders_by_list o on o.list_id=l.id
  left join callbacks_by_list cb on cb.list_id=l.id
  left join members_by_list m on m.list_id=l.id
)
select jsonb_build_object(
  'since',coalesce(p_since,now()-interval '30 days'),
  'attempts',ct.attempts,
  'answered',ct.answered,
  'callSeconds',ct.call_seconds,
  'sentContracts',kt.sent,
  'signedContracts',kt.signed,
  'lists',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',r.id,'name',r.name,'status',r.status,'dialingMode',r.dialing_mode,
      'attempts',r.attempts,'contactRate',r.contact_rate,'orders',r.orders,'revenue',r.revenue,
      'callbacks',r.callbacks,'handledCallbacks',r.handled_callbacks,'remaining',r.remaining
    ) order by r.name)
    from list_rows r
  ),'[]'::jsonb),
  'campaigns',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',c.id,'name',c.name,'status',c.status,'maxAttempts',c.max_attempts
    ) order by c.name)
    from public.campaigns c
  ),'[]'::jsonb)
)
from call_totals ct cross join contract_totals kt
$$;
revoke all on function public.report_sales_overview(timestamptz) from public,anon;
grant execute on function public.report_sales_overview(timestamptz) to authenticated;


-- Per-list seller workload is aggregated server-side so management pages do not
-- infer workload from only the visible page of list members.
create or replace function public.customer_list_seller_workload(p_list_id uuid)
returns table(user_id uuid,remaining bigint)
language sql
stable
security invoker
set search_path=public
as $$
  select m.assigned_user_id,count(*)::bigint
  from public.customer_list_members m
  where m.list_id=p_list_id
    and m.assigned_user_id is not null
    and m.state not in ('completed','blocked')
  group by m.assigned_user_id
$$;

grant execute on function public.customer_list_seller_workload(uuid) to authenticated,service_role;

-- Contract registry pagination and attention filtering stay in PostgreSQL so the
-- browser/server component never downloads hundreds of delivery/reminder rows.
create or replace function public.contract_registry_page(
  p_search text default null,
  p_status text default null,
  p_call_missing boolean default false,
  p_attention text default null,
  p_owner_user_id uuid default null,
  p_team_id uuid default null,
  p_product_id uuid default null,
  p_date_from date default null,
  p_date_to date default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table(
  id uuid,
  contract_number text,
  title text,
  status text,
  audience text,
  source_call_id uuid,
  owner_user_id uuid,
  team_id uuid,
  product_id uuid,
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  customer_name text,
  product_name text,
  latest_delivery_status text,
  latest_delivery_channel text,
  latest_delivery_failure text,
  reminders_sent bigint,
  reminders_overdue bigint
)
language sql
stable
security invoker
set search_path=public
as $$
  select
    c.id,c.contract_number,c.title,c.status::text,c.audience::text,c.source_call_id,c.owner_user_id,c.team_id,c.product_id,
    c.expires_at,c.created_at,c.updated_at,cu.display_name,p.name,
    ld.status::text,ld.channel::text,ld.failure_message,
    coalesce(rs.sent,0),coalesce(rs.overdue,0)
  from public.contracts c
  join public.customers cu on cu.tenant_id=c.tenant_id and cu.id=c.customer_id
  left join public.products p on p.tenant_id=c.tenant_id and p.id=c.product_id
  left join lateral (
    select d.status,d.channel,d.failure_message
    from public.contract_deliveries d
    where d.tenant_id=c.tenant_id and d.contract_id=c.id
    order by d.created_at desc,d.id desc
    limit 1
  ) ld on true
  left join lateral (
    select
      count(*) filter(where r.status='sent') as sent,
      count(*) filter(where r.status='scheduled' and r.scheduled_at<=now()) as overdue
    from public.contract_reminders r
    where r.tenant_id=c.tenant_id and r.contract_id=c.id
  ) rs on true
  where (nullif(trim(coalesce(p_search,'')),'') is null
      or c.contract_number ilike '%'||trim(p_search)||'%'
      or c.title ilike '%'||trim(p_search)||'%'
      or cu.display_name ilike '%'||trim(p_search)||'%')
    and (nullif(trim(coalesce(p_status,'')),'') is null or c.status::text=p_status)
    and (not coalesce(p_call_missing,false) or c.source_call_id is null)
    and (p_owner_user_id is null or c.owner_user_id=p_owner_user_id)
    and (p_team_id is null or c.team_id=p_team_id)
    and (p_product_id is null or c.product_id=p_product_id)
    and (p_date_from is null or c.created_at>=p_date_from::timestamptz)
    and (p_date_to is null or c.created_at<(p_date_to+1)::timestamptz)
    and (
      nullif(trim(coalesce(p_attention,'')),'') is null
      or (p_attention='waiting' and c.status in ('sent','delivered','opened'))
      or (p_attention='delivery_error' and coalesce(ld.status::text,'') in ('failed','bounced','complained','suppressed','dead_letter'))
      or (p_attention='reminder_overdue' and coalesce(rs.overdue,0)>0)
    )
  order by c.updated_at desc,c.id desc
  limit least(greatest(coalesce(p_limit,100),1),201)
  offset greatest(coalesce(p_offset,0),0)
$$;

grant execute on function public.contract_registry_page(text,text,boolean,text,uuid,uuid,uuid,date,date,integer,integer) to authenticated,service_role;

commit;
