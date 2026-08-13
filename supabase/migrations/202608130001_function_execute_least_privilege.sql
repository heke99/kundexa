-- 202608130001_function_execute_least_privilege.sql
--
-- RECONSTRUCTION of a migration that was applied directly to the linked Supabase
-- project (version 202608130001, name `function_execute_least_privilege`) without
-- a corresponding file in this repository. `supabase_migrations.schema_migrations`
-- recorded the version and name but not the statements, so this file was rebuilt
-- from the observed production grant state and is checked in to remove the
-- repo/production history drift. Re-running it is idempotent and produces exactly
-- the grants the linked project already has.
--
-- Effect: PostgreSQL grants EXECUTE to PUBLIC by default on every newly created
-- function, so application-owned routines created without an explicit REVOKE were
-- reachable by the unauthenticated `anon` role through PostgREST
-- (`/rest/v1/rpc/<name>`). This removes PUBLIC/anon EXECUTE from the affected
-- application-owned functions and restores the intended authenticated/service_role
-- grants. Trigger functions receive only the revoke: PostgreSQL rejects a direct
-- call and trigger firing never consults EXECUTE privileges.

revoke all on function public.add_customers_to_list(p_list_id uuid, p_customer_ids uuid[]) from public,anon;
grant execute on function public.add_customers_to_list(p_list_id uuid, p_customer_ids uuid[]) to authenticated;
grant execute on function public.add_customers_to_list(p_list_id uuid, p_customer_ids uuid[]) to service_role;
revoke all on function public.apply_geographic_derived_value(p_entity_id uuid, p_source_entity_id uuid, p_permission_id uuid, p_field_key text, p_value jsonb, p_confidence numeric) from public,anon;
grant execute on function public.apply_geographic_derived_value(p_entity_id uuid, p_source_entity_id uuid, p_permission_id uuid, p_field_key text, p_value jsonb, p_confidence numeric) to authenticated;
grant execute on function public.apply_geographic_derived_value(p_entity_id uuid, p_source_entity_id uuid, p_permission_id uuid, p_field_key text, p_value jsonb, p_confidence numeric) to service_role;
revoke all on function public.approve_contract_template_version(p_version_id uuid) from public,anon;
grant execute on function public.approve_contract_template_version(p_version_id uuid) to authenticated;
grant execute on function public.approve_contract_template_version(p_version_id uuid) to service_role;
revoke all on function public.bootstrap_contract_delivery_defaults() from public,anon;
revoke all on function public.bootstrap_operational_defaults() from public,anon;
revoke all on function public.bootstrap_tenant_defaults() from public,anon;
revoke all on function public.can_access_call(p_call_id uuid) from public,anon;
grant execute on function public.can_access_call(p_call_id uuid) to authenticated;
grant execute on function public.can_access_call(p_call_id uuid) to service_role;
revoke all on function public.can_access_contract(p_contract_id uuid) from public,anon;
grant execute on function public.can_access_contract(p_contract_id uuid) to authenticated;
grant execute on function public.can_access_contract(p_contract_id uuid) to service_role;
revoke all on function public.can_access_customer(p_customer_id uuid) from public,anon;
grant execute on function public.can_access_customer(p_customer_id uuid) to authenticated;
grant execute on function public.can_access_customer(p_customer_id uuid) to service_role;
revoke all on function public.can_access_master_entity(p_entity master_entities) from public,anon;
grant execute on function public.can_access_master_entity(p_entity master_entities) to authenticated;
grant execute on function public.can_access_master_entity(p_entity master_entities) to service_role;
revoke all on function public.can_write_contract(p_contract_id uuid, p_customer_id uuid) from public,anon;
grant execute on function public.can_write_contract(p_contract_id uuid, p_customer_id uuid) to authenticated;
grant execute on function public.can_write_contract(p_contract_id uuid, p_customer_id uuid) to service_role;
revoke all on function public.can_write_customer(p_customer_id uuid) from public,anon;
grant execute on function public.can_write_customer(p_customer_id uuid) to authenticated;
grant execute on function public.can_write_customer(p_customer_id uuid) to service_role;
revoke all on function public.capture_note_revision() from public,anon;
revoke all on function public.claim_next_list_member_with_contacts(p_list_id uuid, p_session_id uuid) from public,anon;
grant execute on function public.claim_next_list_member_with_contacts(p_list_id uuid, p_session_id uuid) to authenticated;
grant execute on function public.claim_next_list_member_with_contacts(p_list_id uuid, p_session_id uuid) to service_role;
revoke all on function public.complete_customer_callback(p_activity_id uuid, p_notes text) from public,anon;
grant execute on function public.complete_customer_callback(p_activity_id uuid, p_notes text) to authenticated;
grant execute on function public.complete_customer_callback(p_activity_id uuid, p_notes text) to service_role;
revoke all on function public.complete_dialer_work(p_call_id uuid, p_disposition_key text, p_notes text, p_callback_scope text, p_callback_due_at timestamp with time zone, p_create_order boolean, p_product_id uuid, p_quantity numeric, p_unit_price numeric, p_idempotency_key text) from public,anon;
grant execute on function public.complete_dialer_work(p_call_id uuid, p_disposition_key text, p_notes text, p_callback_scope text, p_callback_due_at timestamp with time zone, p_create_order boolean, p_product_id uuid, p_quantity numeric, p_unit_price numeric, p_idempotency_key text) to authenticated;
grant execute on function public.complete_dialer_work(p_call_id uuid, p_disposition_key text, p_notes text, p_callback_scope text, p_callback_due_at timestamp with time zone, p_create_order boolean, p_product_id uuid, p_quantity numeric, p_unit_price numeric, p_idempotency_key text) to service_role;
revoke all on function public.complete_manual_call_work(p_call_id uuid, p_disposition text, p_notes text, p_callback_scope text, p_callback_due_at timestamp with time zone) from public,anon;
grant execute on function public.complete_manual_call_work(p_call_id uuid, p_disposition text, p_notes text, p_callback_scope text, p_callback_due_at timestamp with time zone) to authenticated;
grant execute on function public.complete_manual_call_work(p_call_id uuid, p_disposition text, p_notes text, p_callback_scope text, p_callback_due_at timestamp with time zone) to service_role;
revoke all on function public.control_ingestion_run(p_run_id uuid, p_action text) from public,anon;
grant execute on function public.control_ingestion_run(p_run_id uuid, p_action text) to authenticated;
grant execute on function public.control_ingestion_run(p_run_id uuid, p_action text) to service_role;
revoke all on function public.create_contract_draft_v2(p_contract_number text, p_customer_id uuid, p_product_id uuid, p_price_version_id uuid, p_template_id uuid, p_template_version_id uuid, p_legal_entity_id uuid, p_title text, p_rendered_body text, p_rendered_terms text, p_commercial_terms jsonb, p_document_hash text, p_sales_channel text, p_seller_snapshot jsonb, p_counterparty_snapshot jsonb) from public,anon;
grant execute on function public.create_contract_draft_v2(p_contract_number text, p_customer_id uuid, p_product_id uuid, p_price_version_id uuid, p_template_id uuid, p_template_version_id uuid, p_legal_entity_id uuid, p_title text, p_rendered_body text, p_rendered_terms text, p_commercial_terms jsonb, p_document_hash text, p_sales_channel text, p_seller_snapshot jsonb, p_counterparty_snapshot jsonb) to authenticated;
grant execute on function public.create_contract_draft_v2(p_contract_number text, p_customer_id uuid, p_product_id uuid, p_price_version_id uuid, p_template_id uuid, p_template_version_id uuid, p_legal_entity_id uuid, p_title text, p_rendered_body text, p_rendered_terms text, p_commercial_terms jsonb, p_document_hash text, p_sales_channel text, p_seller_snapshot jsonb, p_counterparty_snapshot jsonb) to service_role;
revoke all on function public.create_contract_template_version(p_template_id uuid, p_name text, p_contract_type text, p_audience text, p_description text, p_legal_entity_id uuid, p_title_template text, p_body_template text, p_terms_template text, p_variables jsonb, p_variables_schema jsonb, p_signing_configuration jsonb) from public,anon;
grant execute on function public.create_contract_template_version(p_template_id uuid, p_name text, p_contract_type text, p_audience text, p_description text, p_legal_entity_id uuid, p_title_template text, p_body_template text, p_terms_template text, p_variables jsonb, p_variables_schema jsonb, p_signing_configuration jsonb) to authenticated;
grant execute on function public.create_contract_template_version(p_template_id uuid, p_name text, p_contract_type text, p_audience text, p_description text, p_legal_entity_id uuid, p_title_template text, p_body_template text, p_terms_template text, p_variables jsonb, p_variables_schema jsonb, p_signing_configuration jsonb) to service_role;
revoke all on function public.create_managed_customer_list(p_name text, p_description text, p_list_type text, p_team_id uuid, p_dialing_mode text, p_priority integer, p_start_time time without time zone, p_end_time time without time zone, p_max_attempts integer, p_retry_delay_minutes integer, p_auto_next_delay_seconds integer, p_callback_policy text, p_allow_skip boolean, p_allow_browse boolean, p_script text) from public,anon;
grant execute on function public.create_managed_customer_list(p_name text, p_description text, p_list_type text, p_team_id uuid, p_dialing_mode text, p_priority integer, p_start_time time without time zone, p_end_time time without time zone, p_max_attempts integer, p_retry_delay_minutes integer, p_auto_next_delay_seconds integer, p_callback_policy text, p_allow_skip boolean, p_allow_browse boolean, p_script text) to authenticated;
grant execute on function public.create_managed_customer_list(p_name text, p_description text, p_list_type text, p_team_id uuid, p_dialing_mode text, p_priority integer, p_start_time time without time zone, p_end_time time without time zone, p_max_attempts integer, p_retry_delay_minutes integer, p_auto_next_delay_seconds integer, p_callback_policy text, p_allow_skip boolean, p_allow_browse boolean, p_script text) to service_role;
revoke all on function public.create_or_match_manual_prospect(p_display_name text, p_phone_e164 text, p_customer_type customer_type) from public,anon;
grant execute on function public.create_or_match_manual_prospect(p_display_name text, p_phone_e164 text, p_customer_type customer_type) to authenticated;
grant execute on function public.create_or_match_manual_prospect(p_display_name text, p_phone_e164 text, p_customer_type customer_type) to service_role;
revoke all on function public.current_membership_role() from public,anon;
grant execute on function public.current_membership_role() to authenticated;
grant execute on function public.current_membership_role() to service_role;
revoke all on function public.current_tenant_id() from public,anon;
grant execute on function public.current_tenant_id() to authenticated;
grant execute on function public.current_tenant_id() to service_role;
revoke all on function public.customer_has_legal_retention(p_tenant_id uuid, p_customer_id uuid) from public,anon;
grant execute on function public.customer_has_legal_retention(p_tenant_id uuid, p_customer_id uuid) to authenticated;
grant execute on function public.customer_has_legal_retention(p_tenant_id uuid, p_customer_id uuid) to service_role;
revoke all on function public.emit_call_automation_event() from public,anon;
revoke all on function public.emit_call_webhook_event() from public,anon;
revoke all on function public.emit_contract_automation_event() from public,anon;
revoke all on function public.emit_contract_webhook_event() from public,anon;
revoke all on function public.emit_customer_automation_event() from public,anon;
revoke all on function public.emit_customer_webhook_event() from public,anon;
revoke all on function public.enforce_outbound_contact_policy() from public,anon;
revoke all on function public.handle_new_auth_user() from public,anon;
revoke all on function public.has_current_role(p_roles text[]) from public,anon;
grant execute on function public.has_current_role(p_roles text[]) to authenticated;
grant execute on function public.has_current_role(p_roles text[]) to service_role;
revoke all on function public.is_tenant_admin(p_tenant_id uuid) from public,anon;
grant execute on function public.is_tenant_admin(p_tenant_id uuid) to authenticated;
grant execute on function public.is_tenant_admin(p_tenant_id uuid) to service_role;
revoke all on function public.is_tenant_member(p_tenant_id uuid) from public,anon;
grant execute on function public.is_tenant_member(p_tenant_id uuid) to authenticated;
grant execute on function public.is_tenant_member(p_tenant_id uuid) to service_role;
revoke all on function public.materialize_segment_to_customer_list(p_segment_id uuid, p_list_id uuid) from public,anon;
grant execute on function public.materialize_segment_to_customer_list(p_segment_id uuid, p_list_id uuid) to authenticated;
grant execute on function public.materialize_segment_to_customer_list(p_segment_id uuid, p_list_id uuid) to service_role;
revoke all on function public.merge_master_entities(p_tenant_id uuid, p_target uuid, p_source uuid, p_actor uuid) from public,anon;
grant execute on function public.merge_master_entities(p_tenant_id uuid, p_target uuid, p_source uuid, p_actor uuid) to authenticated;
grant execute on function public.merge_master_entities(p_tenant_id uuid, p_target uuid, p_source uuid, p_actor uuid) to service_role;
revoke all on function public.protect_canonical_contract_documents() from public,anon;
revoke all on function public.protect_contract_template_approval() from public,anon;
revoke all on function public.queue_callback_outbound_call(p_activity_id uuid, p_customer_id uuid, p_callback_token_hash text, p_callback_token text, p_voice_client_number text, p_idempotency_key text, p_purpose text) from public,anon;
grant execute on function public.queue_callback_outbound_call(p_activity_id uuid, p_customer_id uuid, p_callback_token_hash text, p_callback_token text, p_voice_client_number text, p_idempotency_key text, p_purpose text) to authenticated;
grant execute on function public.queue_callback_outbound_call(p_activity_id uuid, p_customer_id uuid, p_callback_token_hash text, p_callback_token text, p_voice_client_number text, p_idempotency_key text, p_purpose text) to service_role;
revoke all on function public.queue_contact_nix_checks_contact_trigger() from public,anon;
revoke all on function public.queue_contact_nix_checks_trigger() from public,anon;
revoke all on function public.queue_dynamic_segment_refresh_trigger() from public,anon;
revoke all on function public.queue_email_message(p_customer_id uuid, p_subject text, p_body text, p_idempotency_key text, p_purpose text) from public,anon;
grant execute on function public.queue_email_message(p_customer_id uuid, p_subject text, p_body text, p_idempotency_key text, p_purpose text) to authenticated;
grant execute on function public.queue_email_message(p_customer_id uuid, p_subject text, p_body text, p_idempotency_key text, p_purpose text) to service_role;
revoke all on function public.queue_sms_message(p_customer_id uuid, p_body text, p_idempotency_key text, p_purpose text) from public,anon;
grant execute on function public.queue_sms_message(p_customer_id uuid, p_body text, p_idempotency_key text, p_purpose text) to authenticated;
grant execute on function public.queue_sms_message(p_customer_id uuid, p_body text, p_idempotency_key text, p_purpose text) to service_role;
revoke all on function public.reassign_customer_callback(p_activity_id uuid, p_user_id uuid) from public,anon;
grant execute on function public.reassign_customer_callback(p_activity_id uuid, p_user_id uuid) to authenticated;
grant execute on function public.reassign_customer_callback(p_activity_id uuid, p_user_id uuid) to service_role;
revoke all on function public.rebuild_master_entity(p_entity_id uuid) from public,anon;
grant execute on function public.rebuild_master_entity(p_entity_id uuid) to authenticated;
grant execute on function public.rebuild_master_entity(p_entity_id uuid) to service_role;
revoke all on function public.recalculate_data_quality(p_entity_id uuid) from public,anon;
grant execute on function public.recalculate_data_quality(p_entity_id uuid) to authenticated;
grant execute on function public.recalculate_data_quality(p_entity_id uuid) to service_role;
revoke all on function public.schedule_customer_callback(p_customer_id uuid, p_list_id uuid, p_scope text, p_due_at timestamp with time zone, p_title text, p_description text) from public,anon;
grant execute on function public.schedule_customer_callback(p_customer_id uuid, p_list_id uuid, p_scope text, p_due_at timestamp with time zone, p_title text, p_description text) to authenticated;
grant execute on function public.schedule_customer_callback(p_customer_id uuid, p_list_id uuid, p_scope text, p_due_at timestamp with time zone, p_title text, p_description text) to service_role;
revoke all on function public.seed_source_priority_policies_for_tenant() from public,anon;
revoke all on function public.seed_telephony_policy() from public,anon;
revoke all on function public.set_customer_list_sellers(p_list_id uuid, p_user_ids uuid[]) from public,anon;
grant execute on function public.set_customer_list_sellers(p_list_id uuid, p_user_ids uuid[]) to authenticated;
grant execute on function public.set_customer_list_sellers(p_list_id uuid, p_user_ids uuid[]) to service_role;
revoke all on function public.set_tenant_feature(p_feature_key text, p_enabled boolean, p_configuration jsonb) from public,anon;
grant execute on function public.set_tenant_feature(p_feature_key text, p_enabled boolean, p_configuration jsonb) to authenticated;
grant execute on function public.set_tenant_feature(p_feature_key text, p_enabled boolean, p_configuration jsonb) to service_role;
revoke all on function public.snooze_customer_callback(p_activity_id uuid, p_snoozed_until timestamp with time zone) from public,anon;
grant execute on function public.snooze_customer_callback(p_activity_id uuid, p_snoozed_until timestamp with time zone) to authenticated;
grant execute on function public.snooze_customer_callback(p_activity_id uuid, p_snoozed_until timestamp with time zone) to service_role;
revoke all on function public.source_priority_for(p_tenant uuid, p_field text, p_source_class text) from public,anon;
grant execute on function public.source_priority_for(p_tenant uuid, p_field text, p_source_class text) to authenticated;
grant execute on function public.source_priority_for(p_tenant uuid, p_field text, p_source_class text) to service_role;
revoke all on function public.start_dialer_session(p_list_id uuid) from public,anon;
grant execute on function public.start_dialer_session(p_list_id uuid) to authenticated;
grant execute on function public.start_dialer_session(p_list_id uuid) to service_role;
revoke all on function public.undo_master_entity_merge(p_decision_id uuid, p_actor uuid) from public,anon;
grant execute on function public.undo_master_entity_merge(p_decision_id uuid, p_actor uuid) to authenticated;
grant execute on function public.undo_master_entity_merge(p_decision_id uuid, p_actor uuid) to service_role;
revoke all on function public.update_customer_list_configuration(p_list_id uuid, p_name text, p_description text, p_status text, p_dialing_mode text, p_priority integer, p_start_time time without time zone, p_end_time time without time zone, p_max_attempts integer, p_retry_delay_minutes integer, p_auto_next_delay_seconds integer, p_callback_policy text, p_allow_skip boolean, p_allow_browse boolean, p_lock_to_seller boolean, p_script text, p_timezone text, p_allowed_days integer[], p_outbound_phone_number_id uuid, p_recording_enabled boolean, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone) from public,anon;
grant execute on function public.update_customer_list_configuration(p_list_id uuid, p_name text, p_description text, p_status text, p_dialing_mode text, p_priority integer, p_start_time time without time zone, p_end_time time without time zone, p_max_attempts integer, p_retry_delay_minutes integer, p_auto_next_delay_seconds integer, p_callback_policy text, p_allow_skip boolean, p_allow_browse boolean, p_lock_to_seller boolean, p_script text, p_timezone text, p_allowed_days integer[], p_outbound_phone_number_id uuid, p_recording_enabled boolean, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone) to authenticated;
grant execute on function public.update_customer_list_configuration(p_list_id uuid, p_name text, p_description text, p_status text, p_dialing_mode text, p_priority integer, p_start_time time without time zone, p_end_time time without time zone, p_max_attempts integer, p_retry_delay_minutes integer, p_auto_next_delay_seconds integer, p_callback_policy text, p_allow_skip boolean, p_allow_browse boolean, p_lock_to_seller boolean, p_script text, p_timezone text, p_allowed_days integer[], p_outbound_phone_number_id uuid, p_recording_enabled boolean, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone) to service_role;
revoke all on function public.upsert_tenant_legal_entity(p_id uuid, p_legal_name text, p_organization_number text, p_address_line1 text, p_postal_code text, p_city text, p_country_code text, p_email text, p_phone_e164 text, p_website text, p_is_default boolean) from public,anon;
grant execute on function public.upsert_tenant_legal_entity(p_id uuid, p_legal_name text, p_organization_number text, p_address_line1 text, p_postal_code text, p_city text, p_country_code text, p_email text, p_phone_e164 text, p_website text, p_is_default boolean) to authenticated;
grant execute on function public.upsert_tenant_legal_entity(p_id uuid, p_legal_name text, p_organization_number text, p_address_line1 text, p_postal_code text, p_city text, p_country_code text, p_email text, p_phone_e164 text, p_website text, p_is_default boolean) to service_role;
revoke all on function public.validate_active_tenant() from public,anon;
revoke all on function public.validate_customer_list_platform_source() from public,anon;
