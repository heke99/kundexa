begin;

-- Every table containing tenant-owned data is protected by RLS. Service-role workers bypass RLS intentionally.
do $$
declare t text;
begin
  foreach t in array array[
    'tenants','profiles','tenant_memberships','teams','team_members','tenant_settings','tenant_features','team_features','usage_limits','audit_logs','security_events',
    'customer_statuses','customers','contact_people','tags','customer_tags','notes','activities','customer_lists','customer_list_members','import_runs','import_rows',
    'products','product_price_versions','pipelines','pipeline_stages','deals','deal_stage_history','campaigns','campaign_teams','campaign_members',
    'tenant_integrations','phone_numbers','call_queues','queue_members','calls','call_events','call_recordings','recording_access_logs','sms_conversations','sms_messages',
    'sms_delivery_events','email_messages','message_templates','provider_webhook_events','outbox_jobs','contract_templates','contract_template_versions','contracts',
    'contract_versions','contract_documents','contract_recipients','contract_deliveries','contract_acceptance_requests','contract_acceptances','contract_events','evidence_packages',
    'automation_rules','automation_versions','automation_runs','compliance_blocks','consents','api_keys','webhook_endpoints','webhook_deliveries','data_providers','provider_usage_logs'
  ] loop execute format('alter table public.%I enable row level security',t); end loop;
end $$;

create policy profiles_self_select on public.profiles for select using(id=auth.uid());
create policy profiles_self_update on public.profiles for update using(id=auth.uid()) with check(id=auth.uid());
create policy tenant_member_select on public.tenants for select using(public.is_tenant_member(id));
create policy membership_self_or_admin_select on public.tenant_memberships for select using(user_id=auth.uid() or public.is_tenant_admin(tenant_id));
create policy membership_admin_all on public.tenant_memberships for all using(public.is_tenant_admin(tenant_id)) with check(public.is_tenant_admin(tenant_id));

-- Generic tenant policy for tables that expose tenant_id directly.
do $$
declare t text;
begin
  foreach t in array array[
    'teams','team_members','tenant_settings','tenant_features','team_features','usage_limits','customer_statuses','customers','contact_people','tags','customer_tags','notes','activities',
    'customer_lists','customer_list_members','import_runs','import_rows','products','product_price_versions','pipelines','pipeline_stages','deals','deal_stage_history','campaigns','campaign_teams',
    'campaign_members','phone_numbers','call_queues','queue_members','calls','call_events','call_recordings','sms_conversations','sms_messages','sms_delivery_events','email_messages',
    'message_templates','contract_templates','contract_template_versions','contracts','contract_versions','contract_documents','contract_recipients','contract_deliveries',
    'contract_acceptance_requests','contract_acceptances','contract_events','evidence_packages','automation_rules','automation_versions','automation_runs','compliance_blocks','consents',
    'webhook_deliveries','data_providers','provider_usage_logs'
  ] loop
    execute format('create policy %I_tenant_select on public.%I for select using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id))',t,t);
    execute format('create policy %I_tenant_insert on public.%I for insert with check(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id))',t,t);
    execute format('create policy %I_tenant_update on public.%I for update using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id)) with check(tenant_id=public.current_tenant_id())',t,t);
    execute format('create policy %I_tenant_delete on public.%I for delete using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))',t,t);
  end loop;
end $$;

-- Secrets, API keys, webhook definitions and audit are admin-only from the browser.
create policy integrations_admin_select on public.tenant_integrations for select using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy integrations_admin_write on public.tenant_integrations for all using(public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy api_keys_admin_select on public.api_keys for select using(public.is_tenant_admin(tenant_id));
create policy api_keys_admin_write on public.api_keys for all using(public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id());
create policy webhook_endpoints_admin_select on public.webhook_endpoints for select using(public.is_tenant_admin(tenant_id));
create policy webhook_endpoints_admin_write on public.webhook_endpoints for all using(public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id());
create policy audit_admin_select on public.audit_logs for select using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy security_admin_select on public.security_events for select using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

-- Outbox and raw provider events are worker-owned; authenticated users can only read sanitized business tables.
create policy outbox_admin_select on public.outbox_jobs for select using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create policy provider_events_admin_select on public.provider_webhook_events for select using(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));

-- Recording access requires a privileged role.
create policy recording_privileged_select on public.recording_access_logs for select using(
  tenant_id=public.current_tenant_id() and public.current_membership_role() in ('owner','admin','team_lead','quality')
);

-- Tenant-scoped object storage paths must start with the active tenant UUID.
create policy contract_files_read on storage.objects for select to authenticated using(bucket_id='contract-documents' and (storage.foldername(name))[1]=public.current_tenant_id()::text);
create policy contract_files_write on storage.objects for insert to authenticated with check(bucket_id='contract-documents' and (storage.foldername(name))[1]=public.current_tenant_id()::text);
create policy import_files_read on storage.objects for select to authenticated using(bucket_id='imports' and (storage.foldername(name))[1]=public.current_tenant_id()::text);
create policy import_files_write on storage.objects for insert to authenticated with check(bucket_id='imports' and (storage.foldername(name))[1]=public.current_tenant_id()::text);
create policy recordings_privileged_read on storage.objects for select to authenticated using(bucket_id='call-recordings' and (storage.foldername(name))[1]=public.current_tenant_id()::text and public.current_membership_role() in ('owner','admin','team_lead','quality'));

-- Immutable tenant_id on every tenant table.
do $$
declare t text;
begin
  foreach t in array array[
    'teams','team_members','tenant_settings','tenant_features','team_features','usage_limits','customer_statuses','customers','contact_people','tags','customer_tags','notes','activities',
    'customer_lists','customer_list_members','import_runs','import_rows','products','product_price_versions','pipelines','pipeline_stages','deals','deal_stage_history','campaigns','campaign_teams',
    'campaign_members','tenant_integrations','phone_numbers','call_queues','queue_members','calls','call_events','call_recordings','recording_access_logs','sms_conversations','sms_messages',
    'sms_delivery_events','email_messages','message_templates','outbox_jobs','contract_templates','contract_template_versions','contracts','contract_versions','contract_documents',
    'contract_recipients','contract_deliveries','contract_acceptance_requests','contract_acceptances','contract_events','evidence_packages','automation_rules','automation_versions',
    'automation_runs','compliance_blocks','consents','api_keys','webhook_endpoints','webhook_deliveries','data_providers','provider_usage_logs'
  ] loop execute format('create trigger %I_tenant_immutable before update of tenant_id on public.%I for each row execute function public.prevent_tenant_move()',t,t); end loop;
end $$;

commit;
