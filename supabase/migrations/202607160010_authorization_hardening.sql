begin;

-- Central role checks. Tenant context is always derived from auth.uid().
create or replace function public.has_current_role(p_roles text[])
returns boolean
language sql stable security definer set search_path=public
as $$
  select coalesce(public.current_membership_role()::text = any(p_roles), false)
$$;

create or replace function public.can_write_customer(p_customer_id uuid default null)
returns boolean
language sql stable security definer set search_path=public
as $$
  select public.has_current_role(array['owner','admin','team_lead','sales','backoffice'])
    and (p_customer_id is null or public.can_access_customer(p_customer_id))
$$;

create or replace function public.can_access_call(p_call_id uuid)
returns boolean
language sql stable security definer set search_path=public
as $$
  select exists (
    select 1
    from public.calls c
    where c.id=p_call_id
      and c.tenant_id=public.current_tenant_id()
      and public.has_current_role(array['owner','admin','team_lead','sales','quality','viewer'])
      and (
        public.has_current_role(array['owner','admin','quality'])
        or c.user_id=auth.uid()
        or (c.customer_id is not null and public.can_access_customer(c.customer_id))
      )
  )
$$;

create or replace function public.can_access_contract(p_contract_id uuid)
returns boolean
language sql stable security definer set search_path=public
as $$
  select exists (
    select 1
    from public.contracts c
    where c.id=p_contract_id
      and c.tenant_id=public.current_tenant_id()
      and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','quality','backoffice','finance','viewer'])
      and (
        public.has_current_role(array['owner','admin','contract_manager','quality','finance'])
        or c.owner_user_id=auth.uid()
        or public.can_access_customer(c.customer_id)
      )
  )
$$;

create or replace function public.can_write_contract(p_contract_id uuid default null, p_customer_id uuid default null)
returns boolean
language sql stable security definer set search_path=public
as $$
  select public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice'])
    and (p_contract_id is null or public.can_access_contract(p_contract_id))
    and (p_customer_id is null or public.can_access_customer(p_customer_id))
$$;

create or replace function public.safe_uuid(p_value text)
returns uuid
language plpgsql immutable
as $$
begin
  return p_value::uuid;
exception when others then
  return null;
end
$$;

-- Configuration tables: members may read the shared setup; only tenant admins write.
do $$
declare t text;
begin
  foreach t in array array[
    'teams','team_members','tenant_settings','tenant_features','team_features','usage_limits',
    'customer_statuses','tags','products','product_price_versions','pipelines','pipeline_stages',
    'campaigns','campaign_teams','phone_numbers','call_queues','queue_members','message_templates',
    'contract_templates','contract_template_versions','automation_rules','automation_versions','data_providers'
  ] loop
    execute format('drop policy if exists %I_tenant_select on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_insert on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_update on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_delete on public.%I',t,t);
    execute format('create policy %I_member_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id))',t,t);
    execute format('create policy %I_admin_write on public.%I for all to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))',t,t);
  end loop;
end $$;

-- Bulk imports are restricted because they expose and mutate large data sets.
do $$
declare t text;
begin
  foreach t in array array['import_runs','import_rows'] loop
    execute format('drop policy if exists %I_tenant_select on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_insert on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_update on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_delete on public.%I',t,t);
    execute format('create policy %I_ops_all on public.%I for all to authenticated using (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''team_lead'',''backoffice''])) with check (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''team_lead'',''backoffice'']))',t,t);
  end loop;
end $$;

-- Personal and team lists.
drop policy if exists customer_lists_tenant_select on public.customer_lists;
drop policy if exists customer_lists_tenant_insert on public.customer_lists;
drop policy if exists customer_lists_tenant_update on public.customer_lists;
drop policy if exists customer_lists_tenant_delete on public.customer_lists;
create policy customer_lists_member_select on public.customer_lists for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy customer_lists_operator_insert on public.customer_lists for insert to authenticated
  with check (tenant_id=public.current_tenant_id() and public.can_write_customer() and (owner_user_id is null or owner_user_id=auth.uid() or public.is_tenant_admin(tenant_id)));
create policy customer_lists_owner_update on public.customer_lists for update to authenticated
  using (tenant_id=public.current_tenant_id() and (owner_user_id=auth.uid() or public.is_tenant_admin(tenant_id)))
  with check (tenant_id=public.current_tenant_id() and (owner_user_id=auth.uid() or public.is_tenant_admin(tenant_id)));
create policy customer_lists_owner_delete on public.customer_lists for delete to authenticated
  using (tenant_id=public.current_tenant_id() and (owner_user_id=auth.uid() or public.is_tenant_admin(tenant_id)));

drop policy if exists customer_list_members_tenant_select on public.customer_list_members;
drop policy if exists customer_list_members_tenant_insert on public.customer_list_members;
drop policy if exists customer_list_members_tenant_update on public.customer_list_members;
drop policy if exists customer_list_members_tenant_delete on public.customer_list_members;
create policy customer_list_members_scoped_select on public.customer_list_members for select to authenticated using (
  customer_list_members.tenant_id=public.current_tenant_id()
  and public.can_access_customer(customer_list_members.customer_id)
  and exists(select 1 from public.customer_lists l where l.id=customer_list_members.list_id and l.tenant_id=customer_list_members.tenant_id)
);
create policy customer_list_members_scoped_insert on public.customer_list_members for insert to authenticated with check (
  customer_list_members.tenant_id=public.current_tenant_id()
  and public.can_write_customer(customer_list_members.customer_id)
  and exists(
    select 1 from public.customer_lists l
    where l.id=customer_list_members.list_id and l.tenant_id=customer_list_members.tenant_id
      and (l.owner_user_id=auth.uid() or public.is_tenant_admin(customer_list_members.tenant_id))
  )
);
create policy customer_list_members_scoped_delete on public.customer_list_members for delete to authenticated using (
  customer_list_members.tenant_id=public.current_tenant_id()
  and exists(
    select 1 from public.customer_lists l
    where l.id=customer_list_members.list_id and l.tenant_id=customer_list_members.tenant_id
      and (l.owner_user_id=auth.uid() or public.is_tenant_admin(customer_list_members.tenant_id))
  )
);

-- Customer child data inherits parent access.
do $$
declare t text;
begin
  foreach t in array array['contact_people','customer_tags','notes','consents'] loop
    execute format('drop policy if exists %I_tenant_select on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_insert on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_update on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_delete on public.%I',t,t);
    execute format('create policy %I_customer_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.can_access_customer(customer_id))',t,t);
    execute format('create policy %I_customer_insert on public.%I for insert to authenticated with check (tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id))',t,t);
    execute format('create policy %I_customer_update on public.%I for update to authenticated using (tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id)) with check (tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id))',t,t);
  end loop;
end $$;
create policy contact_people_customer_delete on public.contact_people for delete to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id));
create policy customer_tags_customer_delete on public.customer_tags for delete to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id));
create policy notes_customer_delete on public.notes for delete to authenticated
  using (tenant_id=public.current_tenant_id() and (public.is_tenant_admin(tenant_id) or created_by=auth.uid()));
create policy consents_admin_delete on public.consents for delete to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

-- Activities may be personal, team-scoped, or customer-scoped.
drop policy if exists activities_tenant_select on public.activities;
drop policy if exists activities_tenant_insert on public.activities;
drop policy if exists activities_tenant_update on public.activities;
drop policy if exists activities_tenant_delete on public.activities;
create policy activities_scoped_select on public.activities for select to authenticated using (
  tenant_id=public.current_tenant_id() and (
    public.has_current_role(array['owner','admin','team_lead','backoffice','quality'])
    or assigned_user_id=auth.uid() or created_by=auth.uid()
    or (customer_id is not null and public.can_access_customer(customer_id))
  )
);
create policy activities_operator_insert on public.activities for insert to authenticated with check (
  tenant_id=public.current_tenant_id()
  and public.can_write_customer(customer_id)
  and (created_by is null or created_by=auth.uid())
);
create policy activities_operator_update on public.activities for update to authenticated using (
  tenant_id=public.current_tenant_id() and (
    public.is_tenant_admin(tenant_id) or assigned_user_id=auth.uid() or created_by=auth.uid()
    or (customer_id is not null and public.can_write_customer(customer_id))
  )
) with check (tenant_id=public.current_tenant_id());
create policy activities_operator_delete on public.activities for delete to authenticated using (
  tenant_id=public.current_tenant_id() and (public.is_tenant_admin(tenant_id) or created_by=auth.uid())
);

-- Deals and campaign membership follow customer access.
drop policy if exists deals_tenant_select on public.deals;
drop policy if exists deals_tenant_insert on public.deals;
drop policy if exists deals_tenant_update on public.deals;
drop policy if exists deals_tenant_delete on public.deals;
create policy deals_scoped_select on public.deals for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_access_customer(customer_id));
create policy deals_scoped_insert on public.deals for insert to authenticated
  with check (tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id));
create policy deals_scoped_update on public.deals for update to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id))
  with check (tenant_id=public.current_tenant_id() and public.can_write_customer(customer_id));
create policy deals_scoped_delete on public.deals for delete to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

drop policy if exists deal_stage_history_tenant_select on public.deal_stage_history;
drop policy if exists deal_stage_history_tenant_insert on public.deal_stage_history;
drop policy if exists deal_stage_history_tenant_update on public.deal_stage_history;
drop policy if exists deal_stage_history_tenant_delete on public.deal_stage_history;
create policy deal_stage_history_scoped_select on public.deal_stage_history for select to authenticated using (
  deal_stage_history.tenant_id=public.current_tenant_id()
  and exists(select 1 from public.deals d where d.id=deal_stage_history.deal_id and d.tenant_id=deal_stage_history.tenant_id and public.can_access_customer(d.customer_id))
);
create policy deal_stage_history_scoped_insert on public.deal_stage_history for insert to authenticated with check (
  deal_stage_history.tenant_id=public.current_tenant_id() and changed_by=auth.uid()
  and exists(select 1 from public.deals d where d.id=deal_stage_history.deal_id and d.tenant_id=deal_stage_history.tenant_id and public.can_write_customer(d.customer_id))
);

drop policy if exists campaign_members_tenant_select on public.campaign_members;
drop policy if exists campaign_members_tenant_insert on public.campaign_members;
drop policy if exists campaign_members_tenant_update on public.campaign_members;
drop policy if exists campaign_members_tenant_delete on public.campaign_members;
create policy campaign_members_scoped_select on public.campaign_members for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_access_customer(customer_id));
create policy campaign_members_ops_write on public.campaign_members for all to authenticated
  using (tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','team_lead']))
  with check (tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','team_lead']) and public.can_access_customer(customer_id));

-- Calls: agents can create/update their own calls; supervisors and quality roles can read by scope.
drop policy if exists calls_tenant_select on public.calls;
drop policy if exists calls_tenant_insert on public.calls;
drop policy if exists calls_tenant_update on public.calls;
drop policy if exists calls_tenant_delete on public.calls;
create policy calls_scoped_select on public.calls for select to authenticated using (public.can_access_call(id));
create policy calls_operator_insert on public.calls for insert to authenticated with check (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales'])
  and user_id=auth.uid()
  and (customer_id is null or public.can_access_customer(customer_id))
);
create policy calls_operator_update on public.calls for update to authenticated using (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales'])
  and (public.is_tenant_admin(tenant_id) or user_id=auth.uid() or public.can_access_call(id))
) with check (tenant_id=public.current_tenant_id());

-- Provider callback data is append-only from service-role workers.
drop policy if exists call_events_tenant_select on public.call_events;
drop policy if exists call_events_tenant_insert on public.call_events;
drop policy if exists call_events_tenant_update on public.call_events;
drop policy if exists call_events_tenant_delete on public.call_events;
create policy call_events_scoped_select on public.call_events for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_access_call(call_id));

drop policy if exists call_recordings_tenant_select on public.call_recordings;
drop policy if exists call_recordings_tenant_insert on public.call_recordings;
drop policy if exists call_recordings_tenant_update on public.call_recordings;
drop policy if exists call_recordings_tenant_delete on public.call_recordings;
create policy call_recordings_privileged_select on public.call_recordings for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.has_current_role(array['owner','admin','team_lead','quality']) and public.can_access_call(call_id));

-- Messaging. Message operators can see customer-scoped conversations and the shared unassigned inbox.
drop policy if exists sms_conversations_tenant_select on public.sms_conversations;
drop policy if exists sms_conversations_tenant_insert on public.sms_conversations;
drop policy if exists sms_conversations_tenant_update on public.sms_conversations;
drop policy if exists sms_conversations_tenant_delete on public.sms_conversations;
create policy sms_conversations_scoped_select on public.sms_conversations for select to authenticated using (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice','viewer'])
  and (customer_id is null or public.can_access_customer(customer_id))
);
create policy sms_conversations_operator_insert on public.sms_conversations for insert to authenticated with check (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice'])
  and (customer_id is null or public.can_access_customer(customer_id))
);
create policy sms_conversations_operator_update on public.sms_conversations for update to authenticated using (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice'])
  and (customer_id is null or public.can_access_customer(customer_id))
) with check (tenant_id=public.current_tenant_id());

drop policy if exists sms_messages_tenant_select on public.sms_messages;
drop policy if exists sms_messages_tenant_insert on public.sms_messages;
drop policy if exists sms_messages_tenant_update on public.sms_messages;
drop policy if exists sms_messages_tenant_delete on public.sms_messages;
create policy sms_messages_scoped_select on public.sms_messages for select to authenticated using (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice','viewer'])
  and (
    customer_id is null or public.can_access_customer(customer_id)
    or (contract_id is not null and public.can_access_contract(contract_id))
  )
);
create policy sms_messages_operator_insert on public.sms_messages for insert to authenticated with check (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice'])
  and direction='outbound'
  and (created_by is null or created_by=auth.uid())
  and (customer_id is null or public.can_access_customer(customer_id))
  and (contract_id is null or public.can_access_contract(contract_id))
);

drop policy if exists sms_delivery_events_tenant_select on public.sms_delivery_events;
drop policy if exists sms_delivery_events_tenant_insert on public.sms_delivery_events;
drop policy if exists sms_delivery_events_tenant_update on public.sms_delivery_events;
drop policy if exists sms_delivery_events_tenant_delete on public.sms_delivery_events;
create policy sms_delivery_events_scoped_select on public.sms_delivery_events for select to authenticated using (
  sms_delivery_events.tenant_id=public.current_tenant_id()
  and exists(select 1 from public.sms_messages m where m.id=sms_delivery_events.sms_message_id and m.tenant_id=sms_delivery_events.tenant_id)
);

drop policy if exists email_messages_tenant_select on public.email_messages;
drop policy if exists email_messages_tenant_insert on public.email_messages;
drop policy if exists email_messages_tenant_update on public.email_messages;
drop policy if exists email_messages_tenant_delete on public.email_messages;
create policy email_messages_scoped_select on public.email_messages for select to authenticated using (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice','viewer'])
  and (customer_id is null or public.can_access_customer(customer_id) or (contract_id is not null and public.can_access_contract(contract_id)))
);
create policy email_messages_operator_insert on public.email_messages for insert to authenticated with check (
  tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','backoffice'])
  and direction='outbound'
  and (created_by is null or created_by=auth.uid())
  and (customer_id is null or public.can_access_customer(customer_id))
  and (contract_id is null or public.can_access_contract(contract_id))
);

-- Contracts and all document/evidence children inherit contract access.
drop policy if exists contracts_tenant_select on public.contracts;
drop policy if exists contracts_tenant_insert on public.contracts;
drop policy if exists contracts_tenant_update on public.contracts;
drop policy if exists contracts_tenant_delete on public.contracts;
create policy contracts_scoped_select on public.contracts for select to authenticated using (public.can_access_contract(id));
create policy contracts_writer_insert on public.contracts for insert to authenticated with check (
  tenant_id=public.current_tenant_id() and public.can_write_contract(null,customer_id) and owner_user_id=auth.uid()
);
create policy contracts_writer_update on public.contracts for update to authenticated using (
  tenant_id=public.current_tenant_id() and public.can_write_contract(id,customer_id)
) with check (tenant_id=public.current_tenant_id() and public.can_write_contract(id,customer_id));
create policy contracts_admin_delete on public.contracts for delete to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id) and status in ('draft','cancelled'));

-- Contract children that users create while preparing/sending an agreement.
do $$
declare t text;
begin
  foreach t in array array['contract_versions','contract_documents','contract_recipients','contract_deliveries','contract_events'] loop
    execute format('drop policy if exists %I_tenant_select on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_insert on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_update on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_delete on public.%I',t,t);
    execute format('create policy %I_contract_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.can_access_contract(contract_id))',t,t);
    execute format('create policy %I_contract_insert on public.%I for insert to authenticated with check (tenant_id=public.current_tenant_id() and public.can_write_contract(contract_id,null))',t,t);
  end loop;
end $$;
create policy contract_versions_contract_update on public.contract_versions for update to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_write_contract(contract_id,null) and locked_at is null)
  with check (tenant_id=public.current_tenant_id() and public.can_write_contract(contract_id,null));
create policy contract_documents_contract_delete on public.contract_documents for delete to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy contract_recipients_contract_update on public.contract_recipients for update to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_write_contract(contract_id,null))
  with check (tenant_id=public.current_tenant_id() and public.can_write_contract(contract_id,null));
create policy contract_deliveries_contract_update on public.contract_deliveries for update to authenticated
  using (false) with check (false);

-- Acceptance requests can be created by contract writers, but only provider/public service paths update decisions.
drop policy if exists contract_acceptance_requests_tenant_select on public.contract_acceptance_requests;
drop policy if exists contract_acceptance_requests_tenant_insert on public.contract_acceptance_requests;
drop policy if exists contract_acceptance_requests_tenant_update on public.contract_acceptance_requests;
drop policy if exists contract_acceptance_requests_tenant_delete on public.contract_acceptance_requests;
create policy acceptance_requests_contract_select on public.contract_acceptance_requests for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_access_contract(contract_id));
create policy acceptance_requests_contract_insert on public.contract_acceptance_requests for insert to authenticated
  with check (tenant_id=public.current_tenant_id() and public.can_write_contract(contract_id,null) and status='pending');

-- Acceptance decisions and evidence are immutable from authenticated browser clients.
do $$
declare t text;
begin
  foreach t in array array['contract_acceptances','evidence_packages'] loop
    execute format('drop policy if exists %I_tenant_select on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_insert on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_update on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_delete on public.%I',t,t);
  end loop;
end $$;

-- Compliance blocks inherit customer access; tenant-wide address/phone blocks are admin-only.
drop policy if exists compliance_blocks_tenant_select on public.compliance_blocks;
drop policy if exists compliance_blocks_tenant_insert on public.compliance_blocks;
drop policy if exists compliance_blocks_tenant_update on public.compliance_blocks;
drop policy if exists compliance_blocks_tenant_delete on public.compliance_blocks;
create policy compliance_blocks_scoped_select on public.compliance_blocks for select to authenticated using (
  tenant_id=public.current_tenant_id() and (public.is_tenant_admin(tenant_id) or (customer_id is not null and public.can_access_customer(customer_id)))
);
create policy compliance_blocks_scoped_insert on public.compliance_blocks for insert to authenticated with check (
  tenant_id=public.current_tenant_id()
  and ((customer_id is not null and public.can_write_customer(customer_id)) or (customer_id is null and public.is_tenant_admin(tenant_id)))
  and (created_by is null or created_by=auth.uid())
);
create policy compliance_blocks_admin_update on public.compliance_blocks for update to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))
  with check (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy compliance_blocks_admin_delete on public.compliance_blocks for delete to authenticated
  using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

-- Worker-generated records are admin-readable and service-role writable only.
do $$
declare t text;
begin
  foreach t in array array['contract_acceptances','evidence_packages','automation_runs','webhook_deliveries','provider_usage_logs'] loop
    execute format('drop policy if exists %I_tenant_select on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_insert on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_update on public.%I',t,t);
    execute format('drop policy if exists %I_tenant_delete on public.%I',t,t);
    execute format('create policy %I_admin_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))',t,t);
  end loop;
end $$;

-- Contract writers also need to read acceptance/evidence results for contracts they can access.
drop policy if exists contract_acceptances_admin_select on public.contract_acceptances;
create policy contract_acceptances_contract_select on public.contract_acceptances for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_access_contract(contract_id));
drop policy if exists evidence_packages_admin_select on public.evidence_packages;
create policy evidence_packages_contract_select on public.evidence_packages for select to authenticated
  using (tenant_id=public.current_tenant_id() and public.can_access_contract(contract_id));

-- Storage authorization follows the entity id in the path: tenant/entity/file.
drop policy if exists contract_files_read on storage.objects;
drop policy if exists contract_files_write on storage.objects;
drop policy if exists import_files_read on storage.objects;
drop policy if exists import_files_write on storage.objects;
drop policy if exists recordings_privileged_read on storage.objects;
create policy contract_files_scoped_read on storage.objects for select to authenticated using (
  bucket_id='contract-documents'
  and (storage.foldername(name))[1]=public.current_tenant_id()::text
  and public.can_access_contract(public.safe_uuid((storage.foldername(name))[2]))
);
create policy contract_files_scoped_write on storage.objects for insert to authenticated with check (
  bucket_id='contract-documents'
  and (storage.foldername(name))[1]=public.current_tenant_id()::text
  and public.can_write_contract(public.safe_uuid((storage.foldername(name))[2]),null)
);
create policy import_files_ops_read on storage.objects for select to authenticated using (
  bucket_id='imports'
  and (storage.foldername(name))[1]=public.current_tenant_id()::text
  and public.has_current_role(array['owner','admin','team_lead','backoffice'])
);
create policy import_files_ops_write on storage.objects for insert to authenticated with check (
  bucket_id='imports'
  and (storage.foldername(name))[1]=public.current_tenant_id()::text
  and public.has_current_role(array['owner','admin','team_lead','backoffice'])
);
create policy recordings_privileged_scoped_read on storage.objects for select to authenticated using (
  bucket_id='call-recordings'
  and (storage.foldername(name))[1]=public.current_tenant_id()::text
  and public.has_current_role(array['owner','admin','team_lead','quality'])
  and public.can_access_call(public.safe_uuid((storage.foldername(name))[2]))
);

-- Atomically claim automation runs so overlapping cron invocations cannot duplicate actions.
create or replace function public.claim_automation_runs(p_worker text, p_limit integer default 25)
returns setof public.automation_runs
language plpgsql security definer set search_path=public
as $$
begin
  return query
  with picked as (
    select id from public.automation_runs
    where status in ('pending','failed') and attempts < 10
    order by created_at asc
    for update skip locked
    limit greatest(1,least(p_limit,100))
  )
  update public.automation_runs r
  set status='processing', started_at=coalesce(r.started_at,now()), attempts=r.attempts+1,
      output=coalesce(r.output,'{}'::jsonb) || jsonb_build_object('worker',p_worker)
  from picked
  where r.id=picked.id
  returning r.*;
end
$$;

-- Security-definer worker RPCs must never be executable by browser roles.
revoke all on function public.claim_outbox_jobs(text,integer) from public, anon, authenticated;
revoke all on function public.complete_outbox_job(uuid) from public, anon, authenticated;
revoke all on function public.fail_outbox_job(uuid,text,integer) from public, anon, authenticated;
revoke all on function public.increment_usage(uuid,text,numeric) from public, anon, authenticated;
revoke all on function public.consume_rate_limit(uuid,text,integer,integer) from public, anon, authenticated;
revoke all on function public.claim_automation_runs(text,integer) from public, anon, authenticated;
grant execute on function public.claim_outbox_jobs(text,integer) to service_role;
grant execute on function public.complete_outbox_job(uuid) to service_role;
grant execute on function public.fail_outbox_job(uuid,text,integer) to service_role;
grant execute on function public.increment_usage(uuid,text,numeric) to service_role;
grant execute on function public.consume_rate_limit(uuid,text,integer,integer) to service_role;
grant execute on function public.claim_automation_runs(text,integer) to service_role;

-- Explicitly expose only safe identity helpers to authenticated users.
revoke all on function public.create_tenant_with_owner(text,text,text) from public, anon;
grant execute on function public.create_tenant_with_owner(text,text,text) to authenticated;
grant execute on function public.current_tenant_id() to authenticated;
grant execute on function public.current_membership_role() to authenticated;
grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.is_tenant_admin(uuid) to authenticated;
grant execute on function public.has_current_role(text[]) to authenticated;
grant execute on function public.can_access_customer(uuid) to authenticated;
grant execute on function public.can_write_customer(uuid) to authenticated;
grant execute on function public.can_access_call(uuid) to authenticated;
grant execute on function public.can_access_contract(uuid) to authenticated;
grant execute on function public.can_write_contract(uuid,uuid) to authenticated;
grant execute on function public.safe_uuid(text) to authenticated;

commit;
