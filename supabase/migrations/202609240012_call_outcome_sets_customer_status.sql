-- Samtalets utfall sätter kundens status.
--
-- "Intresserad", "Inte intresserad" och "Sålt" ändrade bara samtalet. Kundkortet
-- stod kvar som Prospekt, så kundlistan, filtren och nästa säljare såg ingen
-- skillnad mellan en kund som sagt nej och en som aldrig ringts. Utfallet
-- sätts nu på kunden när efterarbetet sparas, oavsett om det kom från
-- ringlistan eller kundkortet.
--
-- Regeln flyttar bara framåt från ett tidigt läge och skriver aldrig över ett
-- beslut: en befintlig kund blir inte förlorad av ett nej, och en spärrad kund
-- rörs inte (spärrar hanteras av apply_call_block_disposition).
--   positivt utfall (listans outcome_group eller intresserad/avtal) -> lead, från prospekt
--   order/sale/sold eller ett utfall som kräver order              -> kund, från prospekt/lead/förlorad
--   not_interested                                                  -> förlorad, från prospekt/lead
begin;

create or replace function public.project_call_outcome_to_customer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_group text;
  v_requires_order boolean := false;
  v_next public.customer_lifecycle;
  v_from public.customer_lifecycle[];
begin
  if new.customer_id is null or new.disposition is null or old.disposition is not distinct from new.disposition then
    return new;
  end if;

  if new.list_id is not null then
    select d.outcome_group, coalesce(d.requires_order, false) into v_group, v_requires_order
      from public.list_dispositions d
     where d.tenant_id = new.tenant_id and d.list_id = new.list_id and d.key = new.disposition;
  end if;
  if v_group is null and new.disposition in ('interested', 'contract', 'contract_requested', 'sale', 'sold', 'order') then
    v_group := 'positive';
  end if;

  if v_requires_order or new.disposition in ('order', 'sale', 'sold') then
    v_next := 'customer'; v_from := array['prospect', 'lead', 'lost']::public.customer_lifecycle[];
  elsif v_group = 'positive' then
    v_next := 'lead'; v_from := array['prospect']::public.customer_lifecycle[];
  elsif new.disposition = 'not_interested' then
    v_next := 'lost'; v_from := array['prospect', 'lead']::public.customer_lifecycle[];
  else
    return new;
  end if;

  update public.customers
     set lifecycle = v_next
   where tenant_id = new.tenant_id and id = new.customer_id and lifecycle = any(v_from);
  return new;
end $$;

revoke all on function public.project_call_outcome_to_customer() from public, anon, authenticated;

drop trigger if exists call_outcome_sets_customer_status on public.calls;
create trigger call_outcome_sets_customer_status
  after update of disposition on public.calls
  for each row
  when (new.disposition is not null and old.disposition is distinct from new.disposition)
  execute function public.project_call_outcome_to_customer();

commit;
