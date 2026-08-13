-- 202608130002_rls_auth_uid_initplan.sql
--
-- RECONSTRUCTION of a migration that was applied directly to the linked Supabase
-- project (version 202608130002, name `rls_auth_uid_initplan`) without a
-- corresponding file in this repository. `supabase_migrations.schema_migrations`
-- recorded the version and name but not the statements, so this file was rebuilt
-- by applying the same transformation the linked project now contains, and is
-- checked in to remove the repo/production history drift.
--
-- Effect: a bare `auth.uid()` inside an RLS expression is re-evaluated per row.
-- Wrapping it as `(select auth.uid())` turns it into an InitPlan that Postgres
-- evaluates once per statement, which is the documented Supabase remedy for the
-- `auth_rls_initplan` advisor. Semantics are unchanged: auth.uid() is STABLE, so
-- the value is constant for the duration of the statement either way.
--
-- 37 policies are rewritten, matching the 37 policies that reference auth.uid()
-- in the linked project.

drop policy if exists activities_callback_aware_update on public.activities;
create policy activities_callback_aware_update on public.activities as permissive for update to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR ((type = 'callback'::activity_type) AND ((assigned_user_id = ( select auth.uid() )) OR (claimed_by = ( select auth.uid() )) OR ((list_id IS NOT NULL) AND can_manage_customer_list(list_id)))) OR ((type <> 'callback'::activity_type) AND ((assigned_user_id = ( select auth.uid() )) OR (created_by = ( select auth.uid() )) OR ((customer_id IS NOT NULL) AND can_write_customer(customer_id))))))) with check ((tenant_id = current_tenant_id()));
drop policy if exists activities_operator_delete on public.activities;
create policy activities_operator_delete on public.activities as permissive for delete to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR (created_by = ( select auth.uid() )))));
drop policy if exists activities_operator_insert on public.activities;
create policy activities_operator_insert on public.activities as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND can_write_customer(customer_id) AND ((created_by IS NULL) OR (created_by = ( select auth.uid() )))));
drop policy if exists activities_role_scoped_select on public.activities;
create policy activities_role_scoped_select on public.activities as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (has_current_role(ARRAY['owner'::text, 'admin'::text, 'backoffice'::text, 'quality'::text]) OR (assigned_user_id = ( select auth.uid() )) OR (created_by = ( select auth.uid() )) OR ((assigned_team_id IS NOT NULL) AND can_manage_team(assigned_team_id)) OR ((customer_id IS NOT NULL) AND can_access_customer(customer_id)) OR ((type = 'callback'::activity_type) AND (callback_scope = 'global'::text) AND (assigned_team_id IS NOT NULL) AND can_operate_in_team(assigned_team_id, ( select auth.uid() ))))));
drop policy if exists audit_member_insert on public.audit_logs;
create policy audit_member_insert on public.audit_logs as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND is_tenant_member(tenant_id) AND (actor_user_id = ( select auth.uid() ))));
drop policy if exists calls_operator_insert on public.calls;
create policy calls_operator_insert on public.calls as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND has_current_role(ARRAY['owner'::text, 'admin'::text, 'team_lead'::text, 'sales'::text]) AND (user_id = ( select auth.uid() )) AND ((customer_id IS NULL) OR can_access_customer(customer_id))));
drop policy if exists calls_operator_update on public.calls;
create policy calls_operator_update on public.calls as permissive for update to authenticated using (((tenant_id = current_tenant_id()) AND has_current_role(ARRAY['owner'::text, 'admin'::text, 'team_lead'::text, 'sales'::text]) AND (is_tenant_admin(tenant_id) OR (user_id = ( select auth.uid() )) OR can_access_call(id)))) with check ((tenant_id = current_tenant_id()));
drop policy if exists compliance_blocks_scoped_insert on public.compliance_blocks;
create policy compliance_blocks_scoped_insert on public.compliance_blocks as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND (((customer_id IS NOT NULL) AND can_write_customer(customer_id)) OR ((customer_id IS NULL) AND is_tenant_admin(tenant_id))) AND ((created_by IS NULL) OR (created_by = ( select auth.uid() )))));
drop policy if exists contracts_writer_insert on public.contracts;
create policy contracts_writer_insert on public.contracts as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND can_write_contract(NULL::uuid, customer_id) AND (owner_user_id = ( select auth.uid() ))));
drop policy if exists customer_list_members_runtime_select on public.customer_list_members;
create policy customer_list_members_runtime_select on public.customer_list_members as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (can_manage_customer_list(list_id) OR (can_work_customer_list(list_id) AND (EXISTS ( SELECT 1
   FROM customer_lists l
  WHERE ((l.tenant_id = customer_list_members.tenant_id) AND (l.id = customer_list_members.list_id) AND (l.allow_browse OR (customer_list_members.claimed_by = ( select auth.uid() )) OR (customer_list_members.assigned_user_id = ( select auth.uid() ))))))))));
drop policy if exists list_sellers_scoped_select on public.customer_list_seller_assignments;
create policy list_sellers_scoped_select on public.customer_list_seller_assignments as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND ((user_id = ( select auth.uid() )) OR can_manage_customer_list(list_id))));
drop policy if exists customer_lists_managed_write on public.customer_lists;
create policy customer_lists_managed_write on public.customer_lists as permissive for all to authenticated using (((tenant_id = current_tenant_id()) AND can_manage_customer_list(id))) with check (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR ((owner_user_id = ( select auth.uid() )) AND has_current_role(ARRAY['team_lead'::text]) AND (team_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.tenant_id = customer_lists.tenant_id) AND (tm.team_id = customer_lists.team_id) AND (tm.user_id = ( select auth.uid() )) AND (tm.role = 'manager'::text))))))));
drop policy if exists deal_stage_history_scoped_insert on public.deal_stage_history;
create policy deal_stage_history_scoped_insert on public.deal_stage_history as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND (changed_by = ( select auth.uid() )) AND (EXISTS ( SELECT 1
   FROM deals d
  WHERE ((d.id = deal_stage_history.deal_id) AND (d.tenant_id = deal_stage_history.tenant_id) AND can_write_customer(d.customer_id))))));
drop policy if exists dialer_sessions_owner_insert on public.dialer_sessions;
create policy dialer_sessions_owner_insert on public.dialer_sessions as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND (user_id = ( select auth.uid() )) AND can_work_customer_list(list_id)));
drop policy if exists dialer_sessions_owner_update on public.dialer_sessions;
create policy dialer_sessions_owner_update on public.dialer_sessions as permissive for update to authenticated using (((tenant_id = current_tenant_id()) AND (user_id = ( select auth.uid() )))) with check (((tenant_id = current_tenant_id()) AND (user_id = ( select auth.uid() ))));
drop policy if exists dialer_sessions_scoped_select on public.dialer_sessions;
create policy dialer_sessions_scoped_select on public.dialer_sessions as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND ((user_id = ( select auth.uid() )) OR can_manage_customer_list(list_id))));
drop policy if exists email_messages_operator_insert on public.email_messages;
create policy email_messages_operator_insert on public.email_messages as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND has_current_role(ARRAY['owner'::text, 'admin'::text, 'team_lead'::text, 'sales'::text, 'contract_manager'::text, 'backoffice'::text]) AND (direction = 'outbound'::communication_direction) AND ((created_by IS NULL) OR (created_by = ( select auth.uid() ))) AND ((customer_id IS NULL) OR can_access_customer(customer_id)) AND ((contract_id IS NULL) OR can_access_contract(contract_id))));
drop policy if exists note_revisions_customer_select on public.note_revisions;
create policy note_revisions_customer_select on public.note_revisions as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM notes n
  WHERE ((n.tenant_id = note_revisions.tenant_id) AND (n.id = note_revisions.note_id) AND can_access_customer(n.customer_id) AND ((n.visibility <> 'private'::text) OR (n.created_by = ( select auth.uid() )) OR is_tenant_admin(n.tenant_id)))))));
drop policy if exists notes_customer_delete on public.notes;
create policy notes_customer_delete on public.notes as permissive for delete to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR (created_by = ( select auth.uid() )))));
drop policy if exists notes_owner_update on public.notes;
create policy notes_owner_update on public.notes as permissive for update to authenticated using (((tenant_id = current_tenant_id()) AND can_write_customer(customer_id) AND ((created_by = ( select auth.uid() )) OR is_tenant_admin(tenant_id)))) with check (((tenant_id = current_tenant_id()) AND can_write_customer(customer_id) AND ((created_by = ( select auth.uid() )) OR is_tenant_admin(tenant_id))));
drop policy if exists notes_visibility_select on public.notes;
create policy notes_visibility_select on public.notes as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND can_access_customer(customer_id) AND ((visibility <> 'private'::text) OR (created_by = ( select auth.uid() )) OR is_tenant_admin(tenant_id))));
drop policy if exists platform_memberships_read on public.platform_memberships;
create policy platform_memberships_read on public.platform_memberships as permissive for select to authenticated using (((user_id = ( select auth.uid() )) OR is_platform_role(ARRAY['platform_owner'::platform_role, 'platform_admin'::platform_role, 'platform_auditor'::platform_role])));
drop policy if exists profiles_scoped_select on public.profiles;
create policy profiles_scoped_select on public.profiles as permissive for select to authenticated using (((id = ( select auth.uid() )) OR (EXISTS ( SELECT 1
   FROM tenant_memberships target_membership
  WHERE ((target_membership.tenant_id = current_tenant_id()) AND (target_membership.user_id = profiles.id) AND (target_membership.status = ANY (ARRAY['invited'::membership_status, 'active'::membership_status])) AND (is_tenant_admin(target_membership.tenant_id) OR (EXISTS ( SELECT 1
           FROM (team_members manager_membership
             JOIN team_members visible_membership ON (((visible_membership.tenant_id = manager_membership.tenant_id) AND (visible_membership.team_id = manager_membership.team_id))))
          WHERE ((manager_membership.tenant_id = target_membership.tenant_id) AND (manager_membership.user_id = ( select auth.uid() )) AND (manager_membership.role = 'manager'::text) AND (visible_membership.user_id = profiles.id))))))))));
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles as permissive for update to public using ((id = ( select auth.uid() ))) with check ((id = ( select auth.uid() )));
drop policy if exists rinkel_number_allocations_scoped_read on public.rinkel_number_allocations;
create policy rinkel_number_allocations_scoped_read on public.rinkel_number_allocations as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR (EXISTS ( SELECT 1
   FROM rinkel_number_grants g
  WHERE ((g.tenant_id = rinkel_number_allocations.tenant_id) AND (g.number_allocation_id = rinkel_number_allocations.id) AND g.active AND (g.access_level = ANY (ARRAY['dial'::text, 'manage'::text])) AND ((g.user_id = ( select auth.uid() )) OR (g.team_id IN ( SELECT tm.team_id
           FROM team_members tm
          WHERE ((tm.tenant_id = rinkel_number_allocations.tenant_id) AND (tm.user_id = ( select auth.uid() )) AND (NOT tm.assignment_paused) AND can_operate_in_team(tm.team_id, ( select auth.uid() ))))))))))));
drop policy if exists rinkel_number_grants_scoped_read on public.rinkel_number_grants;
create policy rinkel_number_grants_scoped_read on public.rinkel_number_grants as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR (user_id = ( select auth.uid() )) OR (team_id IN ( SELECT tm.team_id
   FROM team_members tm
  WHERE ((tm.tenant_id = rinkel_number_grants.tenant_id) AND (tm.user_id = ( select auth.uid() )) AND (NOT tm.assignment_paused) AND can_operate_in_team(tm.team_id, ( select auth.uid() ))))))));
drop policy if exists rinkel_numbers_scoped_select on public.rinkel_numbers;
create policy rinkel_numbers_scoped_select on public.rinkel_numbers as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (has_current_role(ARRAY['owner'::text, 'admin'::text, 'team_lead'::text]) OR (EXISTS ( SELECT 1
   FROM rinkel_user_mappings m
  WHERE ((m.tenant_id = rinkel_numbers.tenant_id) AND (m.default_number_id = rinkel_numbers.id) AND (m.kundexa_user_id = ( select auth.uid() )) AND m.active))))));
drop policy if exists rinkel_user_mappings_scoped_select on public.rinkel_user_mappings;
create policy rinkel_user_mappings_scoped_select on public.rinkel_user_mappings as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR (kundexa_user_id = ( select auth.uid() )) OR (has_current_role(ARRAY['team_lead'::text]) AND (EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.tenant_id = rinkel_user_mappings.tenant_id) AND (tm.user_id = rinkel_user_mappings.kundexa_user_id) AND can_manage_team(tm.team_id))))))));
drop policy if exists rinkel_user_mappings_v2_tenant_read on public.rinkel_user_mappings_v2;
create policy rinkel_user_mappings_v2_tenant_read on public.rinkel_user_mappings_v2 as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR (kundexa_user_id = ( select auth.uid() )))));
drop policy if exists rinkel_users_scoped_select on public.rinkel_users;
create policy rinkel_users_scoped_select on public.rinkel_users as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (has_current_role(ARRAY['owner'::text, 'admin'::text, 'team_lead'::text]) OR (EXISTS ( SELECT 1
   FROM rinkel_user_mappings m
  WHERE ((m.tenant_id = rinkel_users.tenant_id) AND (m.rinkel_user_id = rinkel_users.id) AND (m.kundexa_user_id = ( select auth.uid() )) AND m.active))))));
drop policy if exists sales_orders_customer_insert on public.sales_orders;
create policy sales_orders_customer_insert on public.sales_orders as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND (owner_user_id = ( select auth.uid() )) AND can_write_customer(customer_id)));
drop policy if exists sales_orders_customer_update on public.sales_orders;
create policy sales_orders_customer_update on public.sales_orders as permissive for update to authenticated using (((tenant_id = current_tenant_id()) AND ((owner_user_id = ( select auth.uid() )) OR is_tenant_admin(tenant_id)))) with check ((tenant_id = current_tenant_id()));
drop policy if exists sms_messages_operator_insert on public.sms_messages;
create policy sms_messages_operator_insert on public.sms_messages as permissive for insert to authenticated with check (((tenant_id = current_tenant_id()) AND has_current_role(ARRAY['owner'::text, 'admin'::text, 'team_lead'::text, 'sales'::text, 'contract_manager'::text, 'backoffice'::text]) AND (direction = 'outbound'::communication_direction) AND ((created_by IS NULL) OR (created_by = ( select auth.uid() ))) AND ((customer_id IS NULL) OR can_access_customer(customer_id)) AND ((contract_id IS NULL) OR can_access_contract(contract_id))));
drop policy if exists team_members_role_scoped_select on public.team_members;
create policy team_members_role_scoped_select on public.team_members as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR (user_id = ( select auth.uid() )) OR can_manage_team(team_id))));
drop policy if exists tenant_invitations_read on public.tenant_invitations;
create policy tenant_invitations_read on public.tenant_invitations as permissive for select to authenticated using (((tenant_id = current_tenant_id()) AND (is_tenant_admin(tenant_id) OR (invited_user_id = ( select auth.uid() )) OR (invited_by = ( select auth.uid() )))));
drop policy if exists membership_scoped_select on public.tenant_memberships;
create policy membership_scoped_select on public.tenant_memberships as permissive for select to authenticated using (((user_id = ( select auth.uid() )) OR is_tenant_admin(tenant_id) OR (EXISTS ( SELECT 1
   FROM (team_members manager_membership
     JOIN team_members target_membership ON (((target_membership.tenant_id = manager_membership.tenant_id) AND (target_membership.team_id = manager_membership.team_id))))
  WHERE ((manager_membership.tenant_id = tenant_memberships.tenant_id) AND (manager_membership.user_id = ( select auth.uid() )) AND (manager_membership.role = 'manager'::text) AND (target_membership.user_id = tenant_memberships.user_id))))));
drop policy if exists voice_clients_admin_select on public.voice_clients;
create policy voice_clients_admin_select on public.voice_clients as permissive for select to public using (((tenant_id = current_tenant_id()) AND ((assigned_user_id = ( select auth.uid() )) OR is_tenant_admin(tenant_id))));
