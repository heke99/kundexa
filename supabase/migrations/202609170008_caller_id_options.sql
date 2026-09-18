-- Vilka nummer säljaren får visa för mottagaren.
--
-- Kundkortet hämtade listan ur `get_current_user_rinkel_numbers`, som räknade
-- fram säljarens allokeringar hos leverantören. Med leverantören borta finns
-- inga allokeringar: det som återstår är företagets egna nummer, och frågan är
-- bara vilka av dem som faktiskt kan bära ett samtal.
--
-- Ordningen är inte kosmetisk. Dialern förväljer det första alternativet, så
-- det som `resolve_caller_id_phone_number` skulle ha valt måste ligga först --
-- annars visar säljarens samtal ett annat nummer än listans eller teamets, utan
-- att någon rört en inställning.

create or replace function public.caller_id_options_for_current_user()
returns table(id uuid, number_e164 text, caller_id_source text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_default uuid;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;

  -- Förvalet räknas fram av samma funktion som uppringningen använder. Att
  -- duplicera regeln här hade låtit listan och samtalet driva isär.
  select r.phone_number_id into v_default
  from public.resolve_caller_id_phone_number(v_tenant, null, null, null, null) r;

  return query
  select n.id, n.number_e164,
         case when n.id = v_default then 'tenant_default' else 'available' end
  from public.phone_numbers n
  where n.tenant_id = v_tenant
    and n.status = 'active'
    -- Ett nummer utan röststöd är inget A-nummer. Att erbjuda det ger ett
    -- samtal som avvisas av leverantören med ett fel som inte pekar hit.
    and n.supports_voice
  order by (n.id = v_default) desc, n.number_e164;
end $$;

comment on function public.caller_id_options_for_current_user() is
  'Företagets aktiva röstnummer, med det förvalda A-numret först.';

revoke all on function public.caller_id_options_for_current_user() from public, anon;
grant execute on function public.caller_id_options_for_current_user() to authenticated;
