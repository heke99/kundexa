-- The contract register showed a customer name and nothing else, so there was no
-- way to reach the customer card from a contract, or to see who the agreement
-- actually went out to. It now returns the customer's identity and contact
-- details alongside the name.
--
-- It also returns whether the contract can be deleted at all, computed from the
-- same thing the database enforces rather than guessed at in the page.
--
-- Six child tables refuse a delete, on purpose: contract_acceptance_requests,
-- contract_acceptances, contract_deliveries, evidence_packages, and the
-- email_messages and sms_messages that were actually sent. They are the record
-- of what happened, and a contract that produced any of them can never be
-- deleted — not even after it is cancelled. Eight other children cascade
-- (versions, documents, events, recipients, reminders, signing envelopes,
-- activities, post-sign runs), so a contract that was never sent deletes
-- cleanly.
--
-- Without this the page offered "Radera" on any cancelled contract and the
-- action then failed on a foreign key, showing the reader a raw Postgres
-- constraint name. Found by writing the test for it.

drop function if exists public.contract_registry_page(text, text, boolean, text, uuid, uuid, uuid, date, date, integer, integer);

create function public.contract_registry_page(
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
  id uuid, contract_number text, title text, status text, audience text,
  source_call_id uuid, owner_user_id uuid, team_id uuid, product_id uuid,
  expires_at timestamptz, created_at timestamptz, updated_at timestamptz,
  customer_id uuid, customer_name text, customer_email text, customer_phone text,
  customer_type text, customer_organization_number text,
  product_name text, latest_delivery_status text, latest_delivery_channel text,
  latest_delivery_failure text, reminders_sent bigint, reminders_overdue bigint,
  deletable boolean
)
language sql
stable
set search_path to 'public'
as $function$
  select
    c.id,c.contract_number,c.title,c.status::text,c.audience::text,c.source_call_id,c.owner_user_id,c.team_id,c.product_id,
    c.expires_at,c.created_at,c.updated_at,
    cu.id,cu.display_name,cu.email,cu.phone_e164,cu.customer_type::text,cu.organization_number,
    p.name,
    ld.status::text,ld.channel::text,ld.failure_message,
    coalesce(rs.sent,0),coalesce(rs.overdue,0),
    -- Deletable only when the status allows it AND nothing that records what
    -- happened is hanging off the contract. Both halves are true or it stays.
    (
      c.status::text in ('draft','cancelled')
      and not exists(select 1 from public.contract_acceptance_requests x where x.tenant_id=c.tenant_id and x.contract_id=c.id)
      and not exists(select 1 from public.contract_acceptances x where x.tenant_id=c.tenant_id and x.contract_id=c.id)
      and not exists(select 1 from public.contract_deliveries x where x.tenant_id=c.tenant_id and x.contract_id=c.id)
      and not exists(select 1 from public.evidence_packages x where x.tenant_id=c.tenant_id and x.contract_id=c.id)
      and not exists(select 1 from public.email_messages x where x.tenant_id=c.tenant_id and x.contract_id=c.id)
      and not exists(select 1 from public.sms_messages x where x.tenant_id=c.tenant_id and x.contract_id=c.id)
    )
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
$function$;

revoke all on function public.contract_registry_page(text, text, boolean, text, uuid, uuid, uuid, date, date, integer, integer) from public, anon;
grant execute on function public.contract_registry_page(text, text, boolean, text, uuid, uuid, uuid, date, date, integer, integer) to authenticated, service_role;
