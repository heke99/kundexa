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
    generation: number;
    identity_assurance_level: string;
    provider_recipient_id: string | null;
    required: boolean;
    signed_at: string | null;
    status: string;
  }>;
  contracts: ExtendTable<"contracts", {
    acceptance_generation: number;
    source_call_eligibility_locked_at: string | null;
    source_call_eligibility_snapshot: Json | null;
  }>;
  contract_versions: ExtendTable<"contract_versions", {
    signature_policy_snapshot: Json | null;
  }>;
  contract_acceptance_requests: ExtendTable<"contract_acceptance_requests", {
    generation: number;
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
  platform_worker_heartbeats: TableOrFallback<"platform_worker_heartbeats">;
  tenant_invitations: TableOrFallback<"tenant_invitations">;
  email_delivery_events: TableOrFallback<"email_delivery_events">;
  signing_envelopes: ExtendTable<"signing_envelopes", { generation: number; }>;
  signing_recipients: TableOrFallback<"signing_recipients">;
  signing_attempts: TableOrFallback<"signing_attempts">;
  signing_events: TableOrFallback<"signing_events">;
  signing_documents: TableOrFallback<"signing_documents">;
  contract_post_sign_runs: TableOrFallback<"contract_post_sign_runs">;
};

type MissingFunctionName =
  | "activate_completed_contract"
  | "activate_current_user_invitation"
  | "assert_team_capacity"
  | "can_operate_in_team"
  | "allocate_platform_list_to_tenant"
  | "apply_resend_delivery_event"
  | "cancel_contract_reminders"
  | "complete_dialer_work_v2"
  | "complete_manual_call_work_v2"
  | "contract_registry_page"
  | "create_contract_draft_api_v2"
  | "create_contract_draft_v3"
  | "create_managed_team"
  | "create_managed_team_v2"
  | "create_or_resume_platform_tenant_owner"
  | "complete_user_password_change"
  | "current_user_security_state"
  | "create_platform_tenant"
  | "customer_list_seller_workload"
  | "fail_tenant_invitation"
  | "extend_contract_acceptance_expiry_api_v2"
  | "evaluate_exact_call_policy"
  | "finalize_signing_envelope"
  | "finalize_tenant_invitation"
  | "get_contract_call_eligibility"
  | "get_user_security_state_for_provisioning"
  | "list_current_user_tenants"
  | "mark_tenant_invitation_auth_provisioned"
  | "mark_acceptance_opened"
  | "navigation_badges"
  | "materialize_segment_to_campaign_for_tenant"
  | "prepare_contract_delivery_api_v2"
  | "prepare_contract_delivery_v2"
  | "record_contract_acceptance_v2"
  | "record_contract_acceptance_v3"
  | "report_sales_overview"
  | "record_platform_worker_heartbeat"
  | "refresh_platform_list_counts"
  | "refresh_segment_materialization_for_tenant"
  | "register_external_manual_call"
  | "register_tenant_invitation"
  | "reserve_tenant_invitation"
  | "reserve_tenant_invitation_v2"
  | "remove_managed_team_member"
  | "provision_user_security_state"
  | "resolve_contract_eligible_calls"
  | "revoke_platform_list_allocation"
  | "schedule_manual_contract_reminder"
  | "schedule_manual_contract_reminder_api_v2"
  | "set_managed_team_member"
  | "split_customer_list_to_team"
  | "switch_active_tenant"
  | "telephony_status_for_current_user"
  | "update_managed_team"
  | "update_tenant_member"
  | "update_tenant_member_v2"
  | "tenant_user_security_states"
  | "update_tenant_member_v3";

type FunctionOverrides = {
  [Name in MissingFunctionName]: FunctionOrFallback<Name>;
} & {
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

