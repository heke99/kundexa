import type { Database, Json } from "@/lib/supabase/database.types";

type LooseMigrationTable = {
  Row: Record<string, any>;
  Insert: Record<string, any>;
  Update: Record<string, any>;
  Relationships: [];
};

type LooseMigrationFunction = {
  Args: Record<string, any>;
  Returns: any;
};

type BaseTables = Database["public"]["Tables"];
type BaseFunctions = Database["public"]["Functions"];

/**
 * The Supabase generator does not preserve SQL NULL acceptance for RPC parameters.
 * PostgreSQL still accepts NULL at the transport boundary, while each function keeps
 * its own business validation. Relax RPC argument values only; table writes remain exact.
 */
type NullableRpcArgs<Args> = [Args] extends [never]
  ? never
  : Args extends object
    ? { [Key in keyof Args]: Args[Key] | null }
    : Args;

type RuntimeFunction<FunctionDefinition> = FunctionDefinition extends {
  Args: infer Args;
  Returns: infer Returns;
}
  ? Omit<FunctionDefinition, "Args" | "Returns"> & {
      Args: NullableRpcArgs<Args>;
      Returns: Returns;
    }
  : FunctionDefinition;

type RuntimeBaseFunctions = {
  [Name in keyof BaseFunctions]: RuntimeFunction<BaseFunctions[Name]>;
};

type TableOrFallback<Name extends string> = Name extends keyof BaseTables
  ? BaseTables[Name]
  : LooseMigrationTable;

type FunctionOrFallback<Name extends string> = Name extends keyof BaseFunctions
  ? RuntimeFunction<BaseFunctions[Name]>
  : LooseMigrationFunction;

type ExtendTable<Name extends keyof BaseTables, ExtraRow extends Record<string, unknown>> = {
  Row: BaseTables[Name]["Row"] & ExtraRow;
  Insert: BaseTables[Name]["Insert"] & Partial<ExtraRow>;
  Update: BaseTables[Name]["Update"] & Partial<ExtraRow>;
  Relationships: BaseTables[Name]["Relationships"];
};

type TableOverrides = {
  calls: ExtendTable<"calls", {
    answered_by_user_id: string | null;
    end_cause: string | null;
    external_call_id: string | null;
    follow_up_at: string | null;
    follow_up_required: boolean;
    initiated_at: string | null;
    insights_status: string;
    invalidated_at: string | null;
    invalidated_reason: string | null;
    provider: string;
    provider_cause: string | null;
    provider_outcome: string | null;
    provider_connection_id: string | null;
    provider_device_id: string | null;
    provider_state_updated_at: string | null;
    provider_status: string | null;
    provider_user_id: string | null;
    recording_status: string;
    ring_duration_seconds: number | null;
    team_id: string | null;
    transcription_status: string;
  }>;
  import_runs: ExtendTable<"import_runs", {
    accepted_row_count: number | null;
    execution_idempotency_key: string | null;
    parsed_row_count: number | null;
    rejected_row_count: number | null;
    source_row_count: number | null;
    truncated: boolean;
    truncation_reason: string | null;
    validation_fingerprint: string | null;
  }>;
  email_messages: ExtendTable<"email_messages", {
    provider_status_at: string | null;
  }>;
  contract_deliveries: ExtendTable<"contract_deliveries", {
    provider_status_at: string | null;
  }>;
  contract_recipients: ExtendTable<"contract_recipients", {
    declined_at: string | null;
    expired_at: string | null;
    identity_assurance_level: string;
    provider_recipient_id: string | null;
    required: boolean;
    signed_at: string | null;
    status: string;
  }>;
  contract_template_versions: ExtendTable<"contract_template_versions", {
    signature_policy: Json;
  }>;
  call_insights: TableOrFallback<"call_insights">;
  call_transcripts: TableOrFallback<"call_transcripts">;
  contract_reminder_policies: TableOrFallback<"contract_reminder_policies">;
  contract_reminders: TableOrFallback<"contract_reminders">;
  platform_integrations: ExtendTable<"platform_integrations", {
    is_canonical: boolean;
    last_error_at: string | null;
    last_error_operation: string | null;
  }>;
  platform_list_allocations: TableOrFallback<"platform_list_allocations">;
  platform_list_entries: TableOrFallback<"platform_list_entries">;
  platform_lists: TableOrFallback<"platform_lists">;
  platform_rinkel_capabilities: ExtendTable<"platform_rinkel_capabilities", {
    users_catalog: boolean;
    numbers_catalog: boolean;
    dial_endpoint_reachable: boolean;
    dial_configured: boolean;
    dial_test_succeeded: boolean;
    dial_tested_at: string | null;
    webhooks_registration: boolean;
    core_webhooks_verified: boolean;
    recording_detected: boolean;
    transcription_supported: boolean;
    insights_supported: boolean;
    note_sync_supported: boolean;
  }>;
  platform_rinkel_conflicts: TableOrFallback<"platform_rinkel_conflicts">;
  platform_rinkel_devices: TableOrFallback<"platform_rinkel_devices">;
  platform_rinkel_jobs: ExtendTable<"platform_rinkel_jobs", {
    last_error_code: string | null;
    last_error_message: string | null;
    dead_lettered_at: string | null;
    updated_at: string;
  }>;
  platform_rinkel_numbers: ExtendTable<"platform_rinkel_numbers", {
    is_platform_default: boolean;
  }>;
  platform_rinkel_users: TableOrFallback<"platform_rinkel_users">;
  platform_rinkel_webhook_events: TableOrFallback<"platform_rinkel_webhook_events">;
  platform_rinkel_webhook_subscriptions: ExtendTable<"platform_rinkel_webhook_subscriptions", {
    required: boolean;
    target_url_redacted: string | null;
    provider_active: boolean | null;
    registered_at: string | null;
    test_requested_at: string | null;
    test_received_at: string | null;
    last_processed_at: string | null;
    last_http_status: number | null;
    received_count: number;
    processed_count: number;
    failed_count: number;
    last_error_code: string | null;
    last_error_message: string | null;
  }>;
  platform_worker_heartbeats: TableOrFallback<"platform_worker_heartbeats">;
  rinkel_user_mappings_v2: ExtendTable<"rinkel_user_mappings_v2", {
    selected_device_id: string | null;
  }>;
  rinkel_call_attempts_v2: ExtendTable<"rinkel_call_attempts_v2", {
    selected_device_id: string | null;
    caller_id_source: string | null;
    caller_id_allocation_id: string | null;
  }>;
  rinkel_number_allocations: TableOrFallback<"rinkel_number_allocations">;
  rinkel_user_allocations: TableOrFallback<"rinkel_user_allocations">;
  customer_lists: ExtendTable<"customer_lists", { rinkel_number_allocation_id: string | null; }>;
  campaigns: ExtendTable<"campaigns", { rinkel_number_allocation_id: string | null; }>;
  teams: ExtendTable<"teams", { rinkel_number_allocation_id: string | null; }>;
  telephony_policies: ExtendTable<"telephony_policies", { default_number_allocation_id: string | null; }>;
  tenant_invitations: TableOrFallback<"tenant_invitations">;
  email_delivery_events: TableOrFallback<"email_delivery_events">;
  signing_envelopes: TableOrFallback<"signing_envelopes">;
  signing_recipients: TableOrFallback<"signing_recipients">;
  signing_attempts: TableOrFallback<"signing_attempts">;
  signing_events: TableOrFallback<"signing_events">;
  signing_documents: TableOrFallback<"signing_documents">;
  contract_post_sign_runs: TableOrFallback<"contract_post_sign_runs">;
};

type MissingFunctionName =
  | "activate_current_user_invitation"
  | "allocate_platform_list_to_tenant"
  | "allocate_platform_rinkel_resource"
  | "assign_platform_rinkel_number_to_teams"
  | "apply_resend_delivery_event"
  | "cancel_contract_reminders"
  | "claim_platform_rinkel_jobs"
  | "complete_dialer_work_v2"
  | "complete_manual_call_work_v2"
  | "correlate_rinkel_incoming_event"
  | "correlate_rinkel_outgoing_event"
  | "create_contract_draft_api_v2"
  | "create_contract_draft_v3"
  | "create_managed_team"
  | "create_platform_tenant"
  | "extend_contract_acceptance_expiry_api_v2"
  | "finalize_signing_envelope"
  | "finish_platform_rinkel_job"
  | "get_contract_call_eligibility"
  | "get_current_user_rinkel_numbers"
  | "get_tenant_rinkel_resources"
  | "list_current_user_tenants"
  | "mark_acceptance_opened"
  | "materialize_segment_to_campaign_for_tenant"
  | "prepare_contract_delivery_api_v2"
  | "prepare_contract_delivery_v2"
  | "record_contract_acceptance_v2"
  | "record_platform_rinkel_webhook_failure"
  | "record_platform_rinkel_webhook_processed"
  | "record_platform_rinkel_webhook_receipt"
  | "record_platform_worker_heartbeat"
  | "requeue_platform_rinkel_job"
  | "revoke_platform_rinkel_number_team_grant"
  | "reconcile_rinkel_call_from_cdr"
  | "refresh_platform_list_counts"
  | "refresh_segment_materialization_for_tenant"
  | "register_external_manual_call"
  | "register_tenant_invitation"
  | "remove_managed_team_member"
  | "replace_rinkel_user_mapping_v2"
  | "replace_rinkel_user_mapping_v3"
  | "resolve_contract_eligible_calls"
  | "revoke_platform_list_allocation"
  | "revoke_platform_rinkel_resource"
  | "rinkel_finalize_platform_dial"
  | "rinkel_reserve_platform_outbound_call"
  | "rinkel_reserve_platform_outbound_call_v2"
  | "schedule_manual_contract_reminder"
  | "schedule_manual_contract_reminder_api_v2"
  | "set_managed_team_member"
  | "set_platform_rinkel_default_number"
  | "split_customer_list_to_team"
  | "switch_active_tenant"
  | "telephony_status_for_current_user"
  | "update_managed_team"
  | "update_tenant_member";

type FunctionOverrides = {
  [Name in MissingFunctionName]: FunctionOrFallback<Name>;
} & {
  apply_rinkel_call_event: FunctionOrFallback<"apply_rinkel_call_event">;
};

/**
 * Compatibility type for migrations newer than the checked-in generated snapshot.
 * `npm run types:generate` remains the release source of truth. Once the generated
 * Database type contains an entity, this type automatically resolves to that exact
 * generated table/function instead of its migration fallback.
 */
export type RuntimeDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables" | "Functions"> & {
    Tables: Omit<BaseTables, keyof TableOverrides> & TableOverrides;
    Functions: RuntimeBaseFunctions & FunctionOverrides;
  };
};

