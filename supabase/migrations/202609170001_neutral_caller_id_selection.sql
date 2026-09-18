-- Valet av vilket nummer som visas vid uppringning får inte sitta fast i Rinkel.
--
-- Fyra kärntabeller pekar i dag rakt in i Rinkels egen nummermodell:
--
--   teams.rinkel_number_allocation_id          -> rinkel_number_allocations
--   campaigns.rinkel_number_allocation_id      -> rinkel_number_allocations
--   customer_lists.rinkel_number_allocation_id -> rinkel_number_allocations
--   telephony_policies.default_number_allocation_id -> rinkel_number_allocations
--
-- Det är inte en integrationsdetalj, det är produktfunktionen "vilket nummer
-- visas när man ringer från den här listan, kampanjen eller teamet". Den ska
-- överleva att leverantören byts. Droppas Rinkels tabeller utan att de här
-- kolumnerna först pekat om, försvinner funktionen med dem.
--
-- `phone_numbers` är redan leverantörsneutral -- integration_id,
-- provider_number_id, number_e164, supports_voice, routing_config -- och har
-- unikt index på (tenant_id, id). Den behövde bara aldrig användas, eftersom
-- Rinkel byggde en parallell modell bredvid.
--
-- Ingen backfill. Den enda befintliga allokeringen pekar på ett Rinkel-nummer
-- som är på väg bort, så att flytta över den vore att flytta över skräp. De nya
-- kolumnerna står null tills numret hos den nya leverantören är på plats.
--
-- De gamla kolumnerna rörs inte här. De droppas i samma migration som river
-- Rinkels schema, så den här kan gå i produktion utan att något slutar fungera.

alter table public.teams
  add column if not exists caller_id_phone_number_id uuid;
alter table public.campaigns
  add column if not exists caller_id_phone_number_id uuid;
alter table public.customer_lists
  add column if not exists caller_id_phone_number_id uuid;
alter table public.telephony_policies
  add column if not exists default_caller_id_phone_number_id uuid;

-- Komposit mot (tenant_id, id): ett nummer från en annan tenant ska aldrig gå
-- att välja som A-nummer, och en enkolumns-FK skulle tillåta det.
alter table public.teams
  drop constraint if exists teams_caller_id_phone_number_tenant_fk;
alter table public.teams
  add constraint teams_caller_id_phone_number_tenant_fk
  foreign key (tenant_id, caller_id_phone_number_id)
  references public.phone_numbers (tenant_id, id) on delete set null;

alter table public.campaigns
  drop constraint if exists campaigns_caller_id_phone_number_tenant_fk;
alter table public.campaigns
  add constraint campaigns_caller_id_phone_number_tenant_fk
  foreign key (tenant_id, caller_id_phone_number_id)
  references public.phone_numbers (tenant_id, id) on delete set null;

alter table public.customer_lists
  drop constraint if exists customer_lists_caller_id_phone_number_tenant_fk;
alter table public.customer_lists
  add constraint customer_lists_caller_id_phone_number_tenant_fk
  foreign key (tenant_id, caller_id_phone_number_id)
  references public.phone_numbers (tenant_id, id) on delete set null;

alter table public.telephony_policies
  drop constraint if exists telephony_policies_default_caller_id_phone_number_tenant_fk;
alter table public.telephony_policies
  add constraint telephony_policies_default_caller_id_phone_number_tenant_fk
  foreign key (tenant_id, default_caller_id_phone_number_id)
  references public.phone_numbers (tenant_id, id) on delete set null;

create index if not exists teams_caller_id_phone_number_idx
  on public.teams (tenant_id, caller_id_phone_number_id)
  where caller_id_phone_number_id is not null;
create index if not exists campaigns_caller_id_phone_number_idx
  on public.campaigns (tenant_id, caller_id_phone_number_id)
  where caller_id_phone_number_id is not null;
create index if not exists customer_lists_caller_id_phone_number_idx
  on public.customer_lists (tenant_id, caller_id_phone_number_id)
  where caller_id_phone_number_id is not null;

comment on column public.teams.caller_id_phone_number_id is
  'A-nummer för teamets utgående samtal. Leverantörsneutral ersättare för rinkel_number_allocation_id.';
comment on column public.campaigns.caller_id_phone_number_id is
  'A-nummer för kampanjens utgående samtal. Leverantörsneutral ersättare för rinkel_number_allocation_id.';
comment on column public.customer_lists.caller_id_phone_number_id is
  'A-nummer för listans utgående samtal. Leverantörsneutral ersättare för rinkel_number_allocation_id.';
comment on column public.telephony_policies.default_caller_id_phone_number_id is
  'Tenantens förvalda A-nummer. Leverantörsneutral ersättare för default_number_allocation_id.';
