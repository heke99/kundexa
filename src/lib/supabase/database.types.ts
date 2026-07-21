export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activities: {
        Row: {
          assigned_team_id: string | null
          assigned_user_id: string | null
          callback_scope: string | null
          call_id: string | null
          claim_expires_at: string | null
          claimed_by: string | null
          completed_at: string | null
          contract_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          deal_id: string | null
          description: string | null
          due_at: string | null
          id: string
          handled_at: string | null
          list_id: string | null
          metadata: Json
          priority: string
          recurrence_rule: string | null
          snoozed_until: string | null
          status: Database["public"]["Enums"]["activity_status"]
          tenant_id: string
          title: string
          type: Database["public"]["Enums"]["activity_type"]
          updated_at: string
        }
        Insert: {
          assigned_team_id?: string | null
          assigned_user_id?: string | null
          callback_scope?: string | null
          call_id?: string | null
          claim_expires_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          contract_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          deal_id?: string | null
          description?: string | null
          due_at?: string | null
          id?: string
          handled_at?: string | null
          list_id?: string | null
          metadata?: Json
          priority?: string
          recurrence_rule?: string | null
          snoozed_until?: string | null
          status?: Database["public"]["Enums"]["activity_status"]
          tenant_id: string
          title: string
          type: Database["public"]["Enums"]["activity_type"]
          updated_at?: string
        }
        Update: {
          assigned_team_id?: string | null
          assigned_user_id?: string | null
          callback_scope?: string | null
          call_id?: string | null
          claim_expires_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          contract_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          deal_id?: string | null
          description?: string | null
          due_at?: string | null
          id?: string
          handled_at?: string | null
          list_id?: string | null
          metadata?: Json
          priority?: string
          recurrence_rule?: string | null
          snoozed_until?: string | null
          status?: Database["public"]["Enums"]["activity_status"]
          tenant_id?: string
          title?: string
          type?: Database["public"]["Enums"]["activity_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_contract_tenant_fk"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "activities_deal_tenant_fk"
            columns: ["tenant_id", "deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "activities_tenant_id_assigned_team_id_fkey"
            columns: ["tenant_id", "assigned_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "activities_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "activities_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "activities_tenant_id_deal_id_fkey"
            columns: ["tenant_id", "deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "activities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          rate_limit_per_minute: number
          revoked_at: string | null
          scopes: string[]
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          rate_limit_per_minute?: number
          revoked_at?: string | null
          scopes?: string[]
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          rate_limit_per_minute?: number
          revoked_at?: string | null
          scopes?: string[]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          after_data: Json | null
          before_data: Json | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: number
          ip_address: unknown
          request_id: string | null
          tenant_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: never
          ip_address?: unknown
          request_id?: string | null
          tenant_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: never
          ip_address?: unknown
          request_id?: string | null
          tenant_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_rules: {
        Row: {
          created_at: string
          created_by: string | null
          current_version: number
          description: string | null
          id: string
          name: string
          priority: number
          scope_id: string | null
          scope_type: string
          status: Database["public"]["Enums"]["automation_status"]
          stop_on_match: boolean
          tenant_id: string
          trigger_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          current_version?: number
          description?: string | null
          id?: string
          name: string
          priority?: number
          scope_id?: string | null
          scope_type?: string
          status?: Database["public"]["Enums"]["automation_status"]
          stop_on_match?: boolean
          tenant_id: string
          trigger_key: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          current_version?: number
          description?: string | null
          id?: string
          name?: string
          priority?: number
          scope_id?: string | null
          scope_type?: string
          status?: Database["public"]["Enums"]["automation_status"]
          stop_on_match?: boolean
          tenant_id?: string
          trigger_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_runs: {
        Row: {
          attempts: number
          automation_id: string
          available_at: string
          completed_at: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error: string | null
          id: string
          input: Json
          locked_at: string | null
          locked_by: string | null
          output: Json | null
          priority: number
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          tenant_id: string
          trigger_event_id: string
          version_id: string
        }
        Insert: {
          attempts?: number
          automation_id: string
          available_at?: string
          completed_at?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error?: string | null
          id?: string
          input?: Json
          locked_at?: string | null
          locked_by?: string | null
          output?: Json | null
          priority?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id: string
          trigger_event_id: string
          version_id: string
        }
        Update: {
          attempts?: number
          automation_id?: string
          available_at?: string
          completed_at?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          error?: string | null
          id?: string
          input?: Json
          locked_at?: string | null
          locked_by?: string | null
          output?: Json | null
          priority?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id?: string
          trigger_event_id?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_runs_tenant_id_automation_id_fkey"
            columns: ["tenant_id", "automation_id"]
            isOneToOne: false
            referencedRelation: "automation_rules"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "automation_runs_tenant_id_version_id_fkey"
            columns: ["tenant_id", "version_id"]
            isOneToOne: false
            referencedRelation: "automation_versions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      automation_versions: {
        Row: {
          actions: Json
          approved_by: string | null
          automation_id: string
          conditions: Json
          created_at: string
          created_by: string | null
          delay_config: Json
          exceptions: Json
          id: string
          limits: Json
          tenant_id: string
          test_mode: boolean
          version: number
        }
        Insert: {
          actions?: Json
          approved_by?: string | null
          automation_id: string
          conditions?: Json
          created_at?: string
          created_by?: string | null
          delay_config?: Json
          exceptions?: Json
          id?: string
          limits?: Json
          tenant_id: string
          test_mode?: boolean
          version: number
        }
        Update: {
          actions?: Json
          approved_by?: string | null
          automation_id?: string
          conditions?: Json
          created_at?: string
          created_by?: string | null
          delay_config?: Json
          exceptions?: Json
          id?: string
          limits?: Json
          tenant_id?: string
          test_mode?: boolean
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "automation_versions_tenant_id_automation_id_fkey"
            columns: ["tenant_id", "automation_id"]
            isOneToOne: false
            referencedRelation: "automation_rules"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      call_events: {
        Row: {
          call_id: string
          event_type: string
          id: number
          occurred_at: string
          payload: Json
          provider_event_id: string | null
          tenant_id: string
        }
        Insert: {
          call_id: string
          event_type: string
          id?: never
          occurred_at?: string
          payload?: Json
          provider_event_id?: string | null
          tenant_id: string
        }
        Update: {
          call_id?: string
          event_type?: string
          id?: never
          occurred_at?: string
          payload?: Json
          provider_event_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_events_tenant_id_call_id_fkey"
            columns: ["tenant_id", "call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      call_queues: {
        Row: {
          configuration: Json
          created_at: string
          id: string
          max_wait_seconds: number
          name: string
          overflow_queue_id: string | null
          strategy: string
          tenant_id: string
          updated_at: string
          voicemail_enabled: boolean
        }
        Insert: {
          configuration?: Json
          created_at?: string
          id?: string
          max_wait_seconds?: number
          name: string
          overflow_queue_id?: string | null
          strategy?: string
          tenant_id: string
          updated_at?: string
          voicemail_enabled?: boolean
        }
        Update: {
          configuration?: Json
          created_at?: string
          id?: string
          max_wait_seconds?: number
          name?: string
          overflow_queue_id?: string | null
          strategy?: string
          tenant_id?: string
          updated_at?: string
          voicemail_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "call_queues_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_recordings: {
        Row: {
          call_id: string
          created_at: string
          duration_seconds: number | null
          id: string
          mime_type: string | null
          provider_recording_id: string | null
          retention_until: string | null
          sha256: string | null
          size_bytes: number | null
          status: string
          storage_path: string | null
          tenant_id: string
        }
        Insert: {
          call_id: string
          created_at?: string
          duration_seconds?: number | null
          id?: string
          mime_type?: string | null
          provider_recording_id?: string | null
          retention_until?: string | null
          sha256?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          tenant_id: string
        }
        Update: {
          call_id?: string
          created_at?: string
          duration_seconds?: number | null
          id?: string
          mime_type?: string | null
          provider_recording_id?: string | null
          retention_until?: string | null
          sha256?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_recordings_tenant_id_call_id_fkey"
            columns: ["tenant_id", "call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      calls: {
        Row: {
          after_call_completed_at: string | null
          answered_at: string | null
          callback_activity_id: string | null
          contact_person_id: string | null
          callback_token_hash: string
          campaign_id: string | null
          cost: number | null
          created_at: string
          currency: string | null
          customer_id: string | null
          dialer_session_id: string | null
          direction: Database["public"]["Enums"]["communication_direction"]
          disposition: string | null
          duration_seconds: number | null
          ended_at: string | null
          from_number: string
          id: string
          idempotency_key: string | null
          list_id: string | null
          list_member_id: string | null
          metadata: Json
          notes: string | null
          phone_number_id: string | null
          provider_call_id: string | null
          purpose: string
          queue_id: string | null
          recording_enabled: boolean
          started_at: string | null
          status: string
          tenant_id: string
          to_number: string
          updated_at: string
          user_id: string | null
          wait_seconds: number | null
        }
        Insert: {
          after_call_completed_at?: string | null
          answered_at?: string | null
          callback_activity_id?: string | null
          contact_person_id?: string | null
          callback_token_hash: string
          campaign_id?: string | null
          cost?: number | null
          created_at?: string
          currency?: string | null
          customer_id?: string | null
          dialer_session_id?: string | null
          direction: Database["public"]["Enums"]["communication_direction"]
          disposition?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          from_number: string
          id?: string
          idempotency_key?: string | null
          list_id?: string | null
          list_member_id?: string | null
          metadata?: Json
          notes?: string | null
          phone_number_id?: string | null
          provider_call_id?: string | null
          purpose?: string
          queue_id?: string | null
          recording_enabled?: boolean
          started_at?: string | null
          status?: string
          tenant_id: string
          to_number: string
          updated_at?: string
          user_id?: string | null
          wait_seconds?: number | null
        }
        Update: {
          after_call_completed_at?: string | null
          answered_at?: string | null
          callback_activity_id?: string | null
          contact_person_id?: string | null
          callback_token_hash?: string
          campaign_id?: string | null
          cost?: number | null
          created_at?: string
          currency?: string | null
          customer_id?: string | null
          dialer_session_id?: string | null
          direction?: Database["public"]["Enums"]["communication_direction"]
          disposition?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          from_number?: string
          id?: string
          idempotency_key?: string | null
          list_id?: string | null
          list_member_id?: string | null
          metadata?: Json
          notes?: string | null
          phone_number_id?: string | null
          provider_call_id?: string | null
          purpose?: string
          queue_id?: string | null
          recording_enabled?: boolean
          started_at?: string | null
          status?: string
          tenant_id?: string
          to_number?: string
          updated_at?: string
          user_id?: string | null
          wait_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "calls_customer_tenant_fk"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "calls_tenant_id_campaign_id_fkey"
            columns: ["tenant_id", "campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "calls_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "calls_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_tenant_id_phone_number_id_fkey"
            columns: ["tenant_id", "phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "calls_tenant_id_queue_id_fkey"
            columns: ["tenant_id", "queue_id"]
            isOneToOne: false
            referencedRelation: "call_queues"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      campaign_contact_candidates: {
        Row: {
          campaign_id: string
          created_at: string
          customer_id: string
          evaluated_at: string | null
          policy_reason: string | null
          segment_id: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          customer_id: string
          evaluated_at?: string | null
          policy_reason?: string | null
          segment_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          customer_id?: string
          evaluated_at?: string | null
          policy_reason?: string | null
          segment_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_contact_candidates_tenant_id_campaign_id_fkey"
            columns: ["tenant_id", "campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "campaign_contact_candidates_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "campaign_contact_candidates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_contact_candidates_tenant_id_segment_id_fkey"
            columns: ["tenant_id", "segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      campaign_members: {
        Row: {
          assigned_user_id: string | null
          attempts: number
          campaign_id: string
          created_at: string
          customer_id: string
          next_attempt_at: string | null
          outcome: string | null
          state: string
          tenant_id: string
        }
        Insert: {
          assigned_user_id?: string | null
          attempts?: number
          campaign_id: string
          created_at?: string
          customer_id: string
          next_attempt_at?: string | null
          outcome?: string | null
          state?: string
          tenant_id: string
        }
        Update: {
          assigned_user_id?: string | null
          attempts?: number
          campaign_id?: string
          created_at?: string
          customer_id?: string
          next_attempt_at?: string | null
          outcome?: string | null
          state?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_members_tenant_id_campaign_id_fkey"
            columns: ["tenant_id", "campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "campaign_members_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      campaign_teams: {
        Row: {
          campaign_id: string
          team_id: string
          tenant_id: string
        }
        Insert: {
          campaign_id: string
          team_id: string
          tenant_id: string
        }
        Update: {
          campaign_id?: string
          team_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_teams_tenant_id_campaign_id_fkey"
            columns: ["tenant_id", "campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "campaign_teams_tenant_id_team_id_fkey"
            columns: ["tenant_id", "team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      campaigns: {
        Row: {
          allowed_days: number[]
          allowed_end_time: string
          allowed_start_time: string
          budget: number | null
          cost_limit: number | null
          created_at: string
          created_by: string | null
          description: string | null
          ends_at: string | null
          goals: Json
          id: string
          max_attempts: number
          name: string
          questionnaire: Json
          retry_rules: Json
          script: string | null
          starts_at: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          allowed_days?: number[]
          allowed_end_time?: string
          allowed_start_time?: string
          budget?: number | null
          cost_limit?: number | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          ends_at?: string | null
          goals?: Json
          id?: string
          max_attempts?: number
          name: string
          questionnaire?: Json
          retry_rules?: Json
          script?: string | null
          starts_at?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          allowed_days?: number[]
          allowed_end_time?: string
          allowed_start_time?: string
          budget?: number | null
          cost_limit?: number | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          ends_at?: string | null
          goals?: Json
          id?: string
          max_attempts?: number
          name?: string
          questionnaire?: Json
          retry_rules?: Json
          script?: string | null
          starts_at?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_blocks: {
        Row: {
          active: boolean
          channels: string[]
          created_at: string
          created_by: string | null
          customer_id: string | null
          email: string | null
          expires_at: string | null
          id: string
          phone_e164: string | null
          reason: string
          source: string
          tenant_id: string
        }
        Insert: {
          active?: boolean
          channels?: string[]
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          email?: string | null
          expires_at?: string | null
          id?: string
          phone_e164?: string | null
          reason: string
          source?: string
          tenant_id: string
        }
        Update: {
          active?: boolean
          channels?: string[]
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          email?: string | null
          expires_at?: string | null
          id?: string
          phone_e164?: string | null
          reason?: string
          source?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_blocks_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "compliance_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      consents: {
        Row: {
          created_at: string
          customer_id: string
          evidence: Json
          expires_at: string | null
          granted_at: string | null
          id: string
          legal_basis: string
          purpose: string
          source: string | null
          status: string
          tenant_id: string
          withdrawn_at: string | null
        }
        Insert: {
          created_at?: string
          customer_id: string
          evidence?: Json
          expires_at?: string | null
          granted_at?: string | null
          id?: string
          legal_basis: string
          purpose: string
          source?: string | null
          status: string
          tenant_id: string
          withdrawn_at?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string
          evidence?: Json
          expires_at?: string | null
          granted_at?: string | null
          id?: string
          legal_basis?: string
          purpose?: string
          source?: string | null
          status?: string
          tenant_id?: string
          withdrawn_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "consents_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contact_people: {
        Row: {
          alternate_phone_e164: string | null
          created_at: string
          customer_id: string
          email: string | null
          first_name: string | null
          full_name: string
          id: string
          is_primary: boolean
          is_signatory: boolean
          last_name: string | null
          ownership_percentage: number | null
          phone_e164: string | null
          raw_source_data: Json
          role: string | null
          source_external_id: string | null
          source_import_run_id: string | null
          source_retrieved_at: string | null
          source_url: string | null
          tenant_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          alternate_phone_e164?: string | null
          created_at?: string
          customer_id: string
          email?: string | null
          first_name?: string | null
          full_name: string
          id?: string
          is_primary?: boolean
          is_signatory?: boolean
          last_name?: string | null
          ownership_percentage?: number | null
          phone_e164?: string | null
          raw_source_data?: Json
          role?: string | null
          source_external_id?: string | null
          source_import_run_id?: string | null
          source_retrieved_at?: string | null
          source_url?: string | null
          tenant_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          alternate_phone_e164?: string | null
          created_at?: string
          customer_id?: string
          email?: string | null
          first_name?: string | null
          full_name?: string
          id?: string
          is_primary?: boolean
          is_signatory?: boolean
          last_name?: string | null
          ownership_percentage?: number | null
          phone_e164?: string | null
          raw_source_data?: Json
          role?: string | null
          source_external_id?: string | null
          source_import_run_id?: string | null
          source_retrieved_at?: string | null
          source_url?: string | null
          tenant_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          { foreignKeyName: "contact_people_tenant_id_customer_id_fkey"; columns: ["tenant_id", "customer_id"]; isOneToOne: false; referencedRelation: "customers"; referencedColumns: ["tenant_id", "id"] },
          { foreignKeyName: "contact_people_source_import_fk"; columns: ["tenant_id", "source_import_run_id"]; isOneToOne: false; referencedRelation: "import_runs"; referencedColumns: ["tenant_id", "id"] },
        ]
      }
      contact_permissions: {
        Row: {
          channel: string
          created_at: string
          created_by: string | null
          customer_id: string
          evidence: Json
          id: string
          legal_basis: string | null
          purpose: string
          source: string
          status: string
          tenant_id: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          channel: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          evidence?: Json
          id?: string
          legal_basis?: string | null
          purpose?: string
          source: string
          status: string
          tenant_id: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          channel?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          evidence?: Json
          id?: string
          legal_basis?: string | null
          purpose?: string
          source?: string
          status?: string
          tenant_id?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contact_permissions_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contract_acceptance_requests: {
        Row: {
          acceptance_code: string | null
          accepted_at: string | null
          allowed_phrases: string[]
          call_ended_at: string | null
          call_id: string | null
          contract_id: string
          contract_version_id: string
          created_at: string
          decline_phrases: string[]
          expires_at: string
          id: string
          method: Database["public"]["Enums"]["acceptance_method"]
          opened_at: string | null
          public_token_hash: string
          recipient_id: string
          require_code: boolean
          status: Database["public"]["Enums"]["acceptance_status"]
          tenant_id: string
        }
        Insert: {
          acceptance_code?: string | null
          accepted_at?: string | null
          allowed_phrases?: string[]
          call_ended_at?: string | null
          call_id?: string | null
          contract_id: string
          contract_version_id: string
          created_at?: string
          decline_phrases?: string[]
          expires_at: string
          id?: string
          method: Database["public"]["Enums"]["acceptance_method"]
          opened_at?: string | null
          public_token_hash: string
          recipient_id: string
          require_code?: boolean
          status?: Database["public"]["Enums"]["acceptance_status"]
          tenant_id: string
        }
        Update: {
          acceptance_code?: string | null
          accepted_at?: string | null
          allowed_phrases?: string[]
          call_ended_at?: string | null
          call_id?: string | null
          contract_id?: string
          contract_version_id?: string
          created_at?: string
          decline_phrases?: string[]
          expires_at?: string
          id?: string
          method?: Database["public"]["Enums"]["acceptance_method"]
          opened_at?: string | null
          public_token_hash?: string
          recipient_id?: string
          require_code?: boolean
          status?: Database["public"]["Enums"]["acceptance_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_acceptance_requests_tenant_id_call_id_fkey"
            columns: ["tenant_id", "call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_acceptance_requests_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_acceptance_requests_tenant_id_contract_version_id_fkey"
            columns: ["tenant_id", "contract_version_id"]
            isOneToOne: false
            referencedRelation: "contract_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_acceptance_requests_tenant_id_recipient_id_fkey"
            columns: ["tenant_id", "recipient_id"]
            isOneToOne: false
            referencedRelation: "contract_recipients"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contract_acceptances: {
        Row: {
          acceptance_code: string | null
          acceptance_phrase: string | null
          accepted_at: string | null
          contract_id: string
          contract_version_id: string
          created_at: string
          evidence: Json
          id: string
          ip_address: unknown
          method: Database["public"]["Enums"]["acceptance_method"]
          normalized_response: string | null
          provider_message_id: string | null
          raw_response: string | null
          recipient_id: string
          request_id: string
          status: Database["public"]["Enums"]["acceptance_status"]
          tenant_id: string
          user_agent: string | null
        }
        Insert: {
          acceptance_code?: string | null
          acceptance_phrase?: string | null
          accepted_at?: string | null
          contract_id: string
          contract_version_id: string
          created_at?: string
          evidence?: Json
          id?: string
          ip_address?: unknown
          method: Database["public"]["Enums"]["acceptance_method"]
          normalized_response?: string | null
          provider_message_id?: string | null
          raw_response?: string | null
          recipient_id: string
          request_id: string
          status: Database["public"]["Enums"]["acceptance_status"]
          tenant_id: string
          user_agent?: string | null
        }
        Update: {
          acceptance_code?: string | null
          acceptance_phrase?: string | null
          accepted_at?: string | null
          contract_id?: string
          contract_version_id?: string
          created_at?: string
          evidence?: Json
          id?: string
          ip_address?: unknown
          method?: Database["public"]["Enums"]["acceptance_method"]
          normalized_response?: string | null
          provider_message_id?: string | null
          raw_response?: string | null
          recipient_id?: string
          request_id?: string
          status?: Database["public"]["Enums"]["acceptance_status"]
          tenant_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contract_acceptances_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_acceptances_tenant_id_contract_version_id_fkey"
            columns: ["tenant_id", "contract_version_id"]
            isOneToOne: false
            referencedRelation: "contract_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_acceptances_tenant_id_recipient_id_fkey"
            columns: ["tenant_id", "recipient_id"]
            isOneToOne: false
            referencedRelation: "contract_recipients"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_acceptances_tenant_id_request_id_fkey"
            columns: ["tenant_id", "request_id"]
            isOneToOne: true
            referencedRelation: "contract_acceptance_requests"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contract_deliveries: {
        Row: {
          channel: string
          contract_id: string
          contract_version_id: string
          created_at: string
          delivered_at: string | null
          email_message_id: string | null
          id: string
          idempotency_key: string | null
          opened_at: string | null
          recipient_id: string
          sent_at: string | null
          sms_message_id: string | null
          status: Database["public"]["Enums"]["delivery_status"]
          tenant_id: string
        }
        Insert: {
          channel: string
          contract_id: string
          contract_version_id: string
          created_at?: string
          delivered_at?: string | null
          email_message_id?: string | null
          id?: string
          idempotency_key?: string | null
          opened_at?: string | null
          recipient_id: string
          sent_at?: string | null
          sms_message_id?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          tenant_id: string
        }
        Update: {
          channel?: string
          contract_id?: string
          contract_version_id?: string
          created_at?: string
          delivered_at?: string | null
          email_message_id?: string | null
          id?: string
          idempotency_key?: string | null
          opened_at?: string | null
          recipient_id?: string
          sent_at?: string | null
          sms_message_id?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_deliveries_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_deliveries_tenant_id_contract_version_id_fkey"
            columns: ["tenant_id", "contract_version_id"]
            isOneToOne: false
            referencedRelation: "contract_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_deliveries_tenant_id_email_message_id_fkey"
            columns: ["tenant_id", "email_message_id"]
            isOneToOne: false
            referencedRelation: "email_messages"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_deliveries_tenant_id_recipient_id_fkey"
            columns: ["tenant_id", "recipient_id"]
            isOneToOne: false
            referencedRelation: "contract_recipients"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_deliveries_tenant_id_sms_message_id_fkey"
            columns: ["tenant_id", "sms_message_id"]
            isOneToOne: false
            referencedRelation: "sms_messages"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contract_documents: {
        Row: {
          contract_id: string
          contract_version_id: string | null
          created_at: string
          document_type: string
          file_name: string
          id: string
          metadata: Json
          mime_type: string
          sha256: string
          size_bytes: number | null
          storage_path: string
          tenant_id: string
        }
        Insert: {
          contract_id: string
          contract_version_id?: string | null
          created_at?: string
          document_type: string
          file_name: string
          id?: string
          metadata?: Json
          mime_type: string
          sha256: string
          size_bytes?: number | null
          storage_path: string
          tenant_id: string
        }
        Update: {
          contract_id?: string
          contract_version_id?: string | null
          created_at?: string
          document_type?: string
          file_name?: string
          id?: string
          metadata?: Json
          mime_type?: string
          sha256?: string
          size_bytes?: number | null
          storage_path?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_documents_contract_tenant_fk"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_documents_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_documents_tenant_id_contract_version_id_fkey"
            columns: ["tenant_id", "contract_version_id"]
            isOneToOne: false
            referencedRelation: "contract_versions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contract_events: {
        Row: {
          actor_user_id: string | null
          contract_id: string
          event_type: string
          id: number
          occurred_at: string
          payload: Json
          tenant_id: string
        }
        Insert: {
          actor_user_id?: string | null
          contract_id: string
          event_type: string
          id?: never
          occurred_at?: string
          payload?: Json
          tenant_id: string
        }
        Update: {
          actor_user_id?: string | null
          contract_id?: string
          event_type?: string
          id?: never
          occurred_at?: string
          payload?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_events_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contract_recipients: {
        Row: {
          company_name: string | null
          contract_id: string
          created_at: string
          email: string | null
          full_name: string
          id: string
          identity_number: string | null
          organization_number: string | null
          phone_e164: string | null
          role: string
          signing_order: number
          tenant_id: string
        }
        Insert: {
          company_name?: string | null
          contract_id: string
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          identity_number?: string | null
          organization_number?: string | null
          phone_e164?: string | null
          role?: string
          signing_order?: number
          tenant_id: string
        }
        Update: {
          company_name?: string | null
          contract_id?: string
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          identity_number?: string | null
          organization_number?: string | null
          phone_e164?: string | null
          role?: string
          signing_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_recipients_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contract_template_versions: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          body_template: string
          created_at: string
          created_by: string | null
          id: string
          signing_configuration: Json
          status: string
          template_id: string
          tenant_id: string
          terms_template: string | null
          title_template: string
          variables: Json
          variables_schema: Json
          version: number
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          body_template: string
          created_at?: string
          created_by?: string | null
          id?: string
          signing_configuration?: Json
          status?: string
          template_id: string
          tenant_id: string
          terms_template?: string | null
          title_template: string
          variables?: Json
          variables_schema?: Json
          version: number
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          body_template?: string
          created_at?: string
          created_by?: string | null
          id?: string
          signing_configuration?: Json
          status?: string
          template_id?: string
          tenant_id?: string
          terms_template?: string | null
          title_template?: string
          variables?: Json
          variables_schema?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "contract_template_versions_tenant_id_template_id_fkey"
            columns: ["tenant_id", "template_id"]
            isOneToOne: false
            referencedRelation: "contract_templates"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contract_templates: {
        Row: {
          active: boolean
          audience: string
          contract_type: string
          created_at: string
          current_version_id: string | null
          description: string | null
          id: string
          legal_entity_id: string | null
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          audience: string
          contract_type: string
          created_at?: string
          current_version_id?: string | null
          description?: string | null
          id?: string
          legal_entity_id?: string | null
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          audience?: string
          contract_type?: string
          created_at?: string
          current_version_id?: string | null
          description?: string | null
          id?: string
          legal_entity_id?: string | null
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_templates_current_version_tenant_fk"
            columns: ["tenant_id", "current_version_id"]
            isOneToOne: false
            referencedRelation: "contract_template_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_templates_legal_entity_tenant_fk"
            columns: ["tenant_id", "legal_entity_id"]
            isOneToOne: false
            referencedRelation: "tenant_legal_entities"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_versions: {
        Row: {
          commercial_terms: Json
          contract_id: string
          created_at: string
          created_by: string | null
          document_hash: string
          id: string
          locked_at: string | null
          price_version_id: string | null
          rendered_body: string
          rendered_terms: string | null
          superseded_at: string | null
          template_version_id: string | null
          tenant_id: string
          title: string
          version: number
        }
        Insert: {
          commercial_terms?: Json
          contract_id: string
          created_at?: string
          created_by?: string | null
          document_hash: string
          id?: string
          locked_at?: string | null
          price_version_id?: string | null
          rendered_body: string
          rendered_terms?: string | null
          superseded_at?: string | null
          template_version_id?: string | null
          tenant_id: string
          title: string
          version: number
        }
        Update: {
          commercial_terms?: Json
          contract_id?: string
          created_at?: string
          created_by?: string | null
          document_hash?: string
          id?: string
          locked_at?: string | null
          price_version_id?: string | null
          rendered_body?: string
          rendered_terms?: string | null
          superseded_at?: string | null
          template_version_id?: string | null
          tenant_id?: string
          title?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "contract_versions_contract_tenant_fk"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_versions_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_versions_tenant_id_price_version_id_fkey"
            columns: ["tenant_id", "price_version_id"]
            isOneToOne: false
            referencedRelation: "product_price_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contract_versions_tenant_id_template_version_id_fkey"
            columns: ["tenant_id", "template_version_id"]
            isOneToOne: false
            referencedRelation: "contract_template_versions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      contracts: {
        Row: {
          accepted_at: string | null
          activated_at: string | null
          active_version_id: string | null
          audience: string
          binding_months: number | null
          campaign_id: string | null
          contract_number: string
          counterparty_snapshot: Json
          created_at: string
          currency: string
          customer_id: string
          deal_id: string | null
          ends_on: string | null
          id: string
          legal_entity_id: string | null
          notice_months: number | null
          owner_user_id: string | null
          product_id: string | null
          renewal_on: string | null
          sales_channel: string
          seller_snapshot: Json
          signed_at: string | null
          starts_on: string | null
          status: Database["public"]["Enums"]["contract_status"]
          team_id: string | null
          template_id: string | null
          tenant_id: string
          terminated_at: string | null
          title: string
          updated_at: string
          value: number
        }
        Insert: {
          accepted_at?: string | null
          activated_at?: string | null
          active_version_id?: string | null
          audience: string
          binding_months?: number | null
          campaign_id?: string | null
          contract_number: string
          counterparty_snapshot?: Json
          created_at?: string
          currency?: string
          customer_id: string
          deal_id?: string | null
          ends_on?: string | null
          id?: string
          legal_entity_id?: string | null
          notice_months?: number | null
          owner_user_id?: string | null
          product_id?: string | null
          renewal_on?: string | null
          sales_channel?: string
          seller_snapshot?: Json
          signed_at?: string | null
          starts_on?: string | null
          status?: Database["public"]["Enums"]["contract_status"]
          team_id?: string | null
          template_id?: string | null
          tenant_id: string
          terminated_at?: string | null
          title: string
          updated_at?: string
          value?: number
        }
        Update: {
          accepted_at?: string | null
          activated_at?: string | null
          active_version_id?: string | null
          audience?: string
          binding_months?: number | null
          campaign_id?: string | null
          contract_number?: string
          counterparty_snapshot?: Json
          created_at?: string
          currency?: string
          customer_id?: string
          deal_id?: string | null
          ends_on?: string | null
          id?: string
          legal_entity_id?: string | null
          notice_months?: number | null
          owner_user_id?: string | null
          product_id?: string | null
          renewal_on?: string | null
          sales_channel?: string
          seller_snapshot?: Json
          signed_at?: string | null
          starts_on?: string | null
          status?: Database["public"]["Enums"]["contract_status"]
          team_id?: string | null
          template_id?: string | null
          tenant_id?: string
          terminated_at?: string | null
          title?: string
          updated_at?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "contracts_active_version_tenant_fk"
            columns: ["tenant_id", "active_version_id"]
            isOneToOne: false
            referencedRelation: "contract_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contracts_legal_entity_tenant_fk"
            columns: ["tenant_id", "legal_entity_id"]
            isOneToOne: false
            referencedRelation: "tenant_legal_entities"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_active_version_id_fkey"
            columns: ["tenant_id", "active_version_id"]
            isOneToOne: false
            referencedRelation: "contract_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_campaign_id_fkey"
            columns: ["tenant_id", "campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_deal_id_fkey"
            columns: ["tenant_id", "deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_team_id_fkey"
            columns: ["tenant_id", "team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contracts_tenant_id_template_id_fkey"
            columns: ["tenant_id", "template_id"]
            isOneToOne: false
            referencedRelation: "contract_templates"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      crawl_checkpoints: {
        Row: {
          changed_records: number
          crawl_plan_id: string | null
          error_records: number
          fetched_records: number
          id: string
          ingestion_run_id: string
          last_error: string | null
          last_external_identifier: string | null
          last_filter: Json
          last_page: string | null
          last_processed_record: string | null
          last_successful_step: string | null
          new_records: number
          next_retry_at: string | null
          remaining_capacity: number | null
          tenant_id: string
          unchanged_records: number
          updated_at: string
        }
        Insert: {
          changed_records?: number
          crawl_plan_id?: string | null
          error_records?: number
          fetched_records?: number
          id?: string
          ingestion_run_id: string
          last_error?: string | null
          last_external_identifier?: string | null
          last_filter?: Json
          last_page?: string | null
          last_processed_record?: string | null
          last_successful_step?: string | null
          new_records?: number
          next_retry_at?: string | null
          remaining_capacity?: number | null
          tenant_id: string
          unchanged_records?: number
          updated_at?: string
        }
        Update: {
          changed_records?: number
          crawl_plan_id?: string | null
          error_records?: number
          fetched_records?: number
          id?: string
          ingestion_run_id?: string
          last_error?: string | null
          last_external_identifier?: string | null
          last_filter?: Json
          last_page?: string | null
          last_processed_record?: string | null
          last_successful_step?: string | null
          new_records?: number
          next_retry_at?: string | null
          remaining_capacity?: number | null
          tenant_id?: string
          unchanged_records?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crawl_checkpoints_tenant_id_crawl_plan_id_fkey"
            columns: ["tenant_id", "crawl_plan_id"]
            isOneToOne: false
            referencedRelation: "crawl_plans"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "crawl_checkpoints_tenant_id_ingestion_run_id_fkey"
            columns: ["tenant_id", "ingestion_run_id"]
            isOneToOne: false
            referencedRelation: "ingestion_runs"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      crawl_plans: {
        Row: {
          created_at: string
          estimated_records: number | null
          filter_definition: Json
          id: string
          ingestion_run_id: string
          priority_bucket: number
          sort_order: number
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          estimated_records?: number | null
          filter_definition?: Json
          id?: string
          ingestion_run_id: string
          priority_bucket: number
          sort_order?: number
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          estimated_records?: number | null
          filter_definition?: Json
          id?: string
          ingestion_run_id?: string
          priority_bucket?: number
          sort_order?: number
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crawl_plans_tenant_id_ingestion_run_id_fkey"
            columns: ["tenant_id", "ingestion_run_id"]
            isOneToOne: false
            referencedRelation: "ingestion_runs"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      customer_list_seller_assignments: {
        Row: {
          created_at: string
          created_by: string | null
          daily_capacity: number | null
          ends_at: string | null
          id: string
          list_id: string
          starts_at: string | null
          status: string
          tenant_id: string
          updated_at: string
          user_id: string
          weight: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          daily_capacity?: number | null
          ends_at?: string | null
          id?: string
          list_id: string
          starts_at?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          user_id: string
          weight?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          daily_capacity?: number | null
          ends_at?: string | null
          id?: string
          list_id?: string
          starts_at?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
          weight?: number
        }
        Relationships: []
      }
      customer_list_contact_candidates: {
        Row: {
          created_at: string
          customer_id: string
          evaluated_at: string | null
          list_id: string
          policy_reason: string | null
          segment_id: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          evaluated_at?: string | null
          list_id: string
          policy_reason?: string | null
          segment_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          evaluated_at?: string | null
          list_id?: string
          policy_reason?: string | null
          segment_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_list_contact_candidates_tenant_id_list_id_fkey"
            columns: ["tenant_id", "list_id"]
            isOneToOne: false
            referencedRelation: "customer_lists"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "customer_list_contact_candidates_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "customer_list_contact_candidates_tenant_id_segment_id_fkey"
            columns: ["tenant_id", "segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      customer_list_members: {
        Row: {
          added_by: string | null
          assigned_user_id: string | null
          attempts: number
          claim_expires_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          customer_id: string
          id: string
          last_call_id: string | null
          last_contacted_at: string | null
          list_id: string
          next_attempt_at: string | null
          outcome: string | null
          priority: number
          compliance_reason: string | null
          compliance_status: string
          source_import_profile_id: string | null
          source_import_run_id: string | null
          source_reason: string | null
          source_segment_id: string | null
          state: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          added_by?: string | null
          assigned_user_id?: string | null
          attempts?: number
          claim_expires_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          customer_id: string
          id?: string
          last_call_id?: string | null
          last_contacted_at?: string | null
          list_id: string
          next_attempt_at?: string | null
          outcome?: string | null
          priority?: number
          compliance_reason?: string | null
          compliance_status?: string
          source_import_profile_id?: string | null
          source_import_run_id?: string | null
          source_reason?: string | null
          source_segment_id?: string | null
          state?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          added_by?: string | null
          assigned_user_id?: string | null
          attempts?: number
          claim_expires_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          customer_id?: string
          id?: string
          last_call_id?: string | null
          last_contacted_at?: string | null
          list_id?: string
          next_attempt_at?: string | null
          outcome?: string | null
          priority?: number
          compliance_reason?: string | null
          compliance_status?: string
          source_import_profile_id?: string | null
          source_import_run_id?: string | null
          source_reason?: string | null
          source_segment_id?: string | null
          state?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_list_members_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "customer_list_members_tenant_id_list_id_fkey"
            columns: ["tenant_id", "list_id"]
            isOneToOne: false
            referencedRelation: "customer_lists"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "customer_list_members_source_segment_fk"
            columns: ["tenant_id", "source_segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      customer_lists: {
        Row: {
          allowed_days: number[]
          allowed_end_time: string
          allowed_start_time: string
          allow_browse: boolean
          allow_skip: boolean
          archived_at: string | null
          auto_next_delay_seconds: number
          callback_policy: string
          created_at: string
          description: string | null
          dialing_mode: string
          distribution_strategy: string
          ends_at: string | null
          filter_definition: Json
          id: string
          is_locked: boolean
          list_type: string
          lock_to_seller: boolean
          max_attempts: number
          name: string
          outbound_phone_number_id: string | null
          owner_user_id: string | null
          priority: number
          questionnaire: Json
          required_disposition: boolean
          retry_delay_minutes: number
          script: string | null
          settings: Json
          starts_at: string | null
          status: string
          team_id: string | null
          tenant_id: string
          timezone: string
          updated_at: string
        }
        Insert: {
          allowed_days?: number[]
          allowed_end_time?: string
          allowed_start_time?: string
          allow_browse?: boolean
          allow_skip?: boolean
          archived_at?: string | null
          auto_next_delay_seconds?: number
          callback_policy?: string
          created_at?: string
          description?: string | null
          dialing_mode?: string
          distribution_strategy?: string
          ends_at?: string | null
          filter_definition?: Json
          id?: string
          is_locked?: boolean
          list_type?: string
          lock_to_seller?: boolean
          max_attempts?: number
          name: string
          outbound_phone_number_id?: string | null
          owner_user_id?: string | null
          priority?: number
          questionnaire?: Json
          required_disposition?: boolean
          retry_delay_minutes?: number
          script?: string | null
          settings?: Json
          starts_at?: string | null
          status?: string
          team_id?: string | null
          tenant_id: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          allowed_days?: number[]
          allowed_end_time?: string
          allowed_start_time?: string
          allow_browse?: boolean
          allow_skip?: boolean
          archived_at?: string | null
          auto_next_delay_seconds?: number
          callback_policy?: string
          created_at?: string
          description?: string | null
          dialing_mode?: string
          distribution_strategy?: string
          ends_at?: string | null
          filter_definition?: Json
          id?: string
          is_locked?: boolean
          list_type?: string
          lock_to_seller?: boolean
          max_attempts?: number
          name?: string
          outbound_phone_number_id?: string | null
          owner_user_id?: string | null
          priority?: number
          questionnaire?: Json
          required_disposition?: boolean
          retry_delay_minutes?: number
          script?: string | null
          settings?: Json
          starts_at?: string | null
          status?: string
          team_id?: string | null
          tenant_id?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_lists_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_lists_tenant_id_team_id_fkey"
            columns: ["tenant_id", "team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      customer_statuses: {
        Row: {
          color: string
          created_at: string
          id: string
          is_system: boolean
          is_terminal: boolean
          key: string
          label: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          is_system?: boolean
          is_terminal?: boolean
          key: string
          label: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          is_system?: boolean
          is_terminal?: boolean
          key?: string
          label?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_statuses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_tags: {
        Row: {
          created_at: string
          customer_id: string
          tag_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          tag_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          tag_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_tags_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "customer_tags_tenant_id_tag_id_fkey"
            columns: ["tenant_id", "tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      customers: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          alternate_phone_e164: string | null
          assigned_team_id: string | null
          assigned_user_id: string | null
          blocked_reason: string | null
          call_attempts: number
          campaign_id: string | null
          city: string | null
          company_name: string | null
          company_status: string | null
          country_code: string
          county: string | null
          created_at: string
          created_by: string | null
          current_supplier: string | null
          custom_fields: Json
          customer_type: Database["public"]["Enums"]["customer_type"]
          deleted_at: string | null
          display_name: string
          do_not_call: boolean
          do_not_email: boolean
          do_not_sms: boolean
          email: string | null
          employee_count: number | null
          employer_registered: boolean | null
          f_tax: boolean | null
          first_name: string | null
          id: string
          industry: string | null
          founded_year: number | null
          last_contact_at: string | null
          last_name: string | null
          latitude: number | null
          legal_basis: string | null
          legal_form: string | null
          lifecycle: Database["public"]["Enums"]["customer_lifecycle"]
          longitude: number | null
          manually_verified_fields: string[]
          marketing_allowed: boolean | null
          municipality: string | null
          next_activity_at: string | null
          organization_number: string | null
          personal_identity_number: string | null
          phone_e164: string | null
          postal_code: string | null
          result: number | null
          revenue: number | null
          sni_code: string | null
          source_external_id: string | null
          source_name: string | null
          source_provider: string | null
          source_website: string | null
          source_url: string | null
          source_import_run_id: string | null
          source_retrieved_at: string | null
          source_verified_at: string | null
          status_id: string | null
          tenant_id: string
          updated_at: string
          vat_registered: boolean | null
          website: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          alternate_phone_e164?: string | null
          assigned_team_id?: string | null
          assigned_user_id?: string | null
          blocked_reason?: string | null
          call_attempts?: number
          campaign_id?: string | null
          city?: string | null
          company_name?: string | null
          company_status?: string | null
          country_code?: string
          county?: string | null
          created_at?: string
          created_by?: string | null
          current_supplier?: string | null
          custom_fields?: Json
          customer_type: Database["public"]["Enums"]["customer_type"]
          deleted_at?: string | null
          display_name: string
          do_not_call?: boolean
          do_not_email?: boolean
          do_not_sms?: boolean
          email?: string | null
          employee_count?: number | null
          employer_registered?: boolean | null
          f_tax?: boolean | null
          first_name?: string | null
          id?: string
          industry?: string | null
          founded_year?: number | null
          last_contact_at?: string | null
          last_name?: string | null
          latitude?: number | null
          legal_basis?: string | null
          legal_form?: string | null
          lifecycle?: Database["public"]["Enums"]["customer_lifecycle"]
          longitude?: number | null
          manually_verified_fields?: string[]
          marketing_allowed?: boolean | null
          municipality?: string | null
          next_activity_at?: string | null
          organization_number?: string | null
          personal_identity_number?: string | null
          phone_e164?: string | null
          postal_code?: string | null
          result?: number | null
          revenue?: number | null
          sni_code?: string | null
          source_external_id?: string | null
          source_name?: string | null
          source_provider?: string | null
          source_website?: string | null
          source_url?: string | null
          source_import_run_id?: string | null
          source_retrieved_at?: string | null
          source_verified_at?: string | null
          status_id?: string | null
          tenant_id: string
          updated_at?: string
          vat_registered?: boolean | null
          website?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          alternate_phone_e164?: string | null
          assigned_team_id?: string | null
          assigned_user_id?: string | null
          blocked_reason?: string | null
          call_attempts?: number
          campaign_id?: string | null
          city?: string | null
          company_name?: string | null
          company_status?: string | null
          country_code?: string
          county?: string | null
          created_at?: string
          created_by?: string | null
          current_supplier?: string | null
          custom_fields?: Json
          customer_type?: Database["public"]["Enums"]["customer_type"]
          deleted_at?: string | null
          display_name?: string
          do_not_call?: boolean
          do_not_email?: boolean
          do_not_sms?: boolean
          email?: string | null
          employee_count?: number | null
          employer_registered?: boolean | null
          f_tax?: boolean | null
          first_name?: string | null
          id?: string
          industry?: string | null
          founded_year?: number | null
          last_contact_at?: string | null
          last_name?: string | null
          latitude?: number | null
          legal_basis?: string | null
          legal_form?: string | null
          lifecycle?: Database["public"]["Enums"]["customer_lifecycle"]
          longitude?: number | null
          manually_verified_fields?: string[]
          marketing_allowed?: boolean | null
          municipality?: string | null
          next_activity_at?: string | null
          organization_number?: string | null
          personal_identity_number?: string | null
          phone_e164?: string | null
          postal_code?: string | null
          result?: number | null
          revenue?: number | null
          sni_code?: string | null
          source_external_id?: string | null
          source_name?: string | null
          source_provider?: string | null
          source_website?: string | null
          source_url?: string | null
          source_import_run_id?: string | null
          source_retrieved_at?: string | null
          source_verified_at?: string | null
          status_id?: string | null
          tenant_id?: string
          updated_at?: string
          vat_registered?: boolean | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_tenant_id_assigned_team_id_fkey"
            columns: ["tenant_id", "assigned_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "customers_tenant_id_campaign_id_fkey"
            columns: ["tenant_id", "campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_tenant_id_status_id_fkey"
            columns: ["tenant_id", "status_id"]
            isOneToOne: false
            referencedRelation: "customer_statuses"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      data_conflicts: {
        Row: {
          candidate_values: Json
          created_at: string
          field_key: string
          id: string
          master_entity_id: string
          resolution: Json | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          tenant_id: string | null
        }
        Insert: {
          candidate_values: Json
          created_at?: string
          field_key: string
          id?: string
          master_entity_id: string
          resolution?: Json | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          tenant_id?: string | null
        }
        Update: {
          candidate_values?: Json
          created_at?: string
          field_key?: string
          id?: string
          master_entity_id?: string
          resolution?: Json | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "data_conflicts_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_conflicts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      data_providers: {
        Row: {
          adapter_key: string | null
          allow_export: boolean
          allow_raw_storage: boolean
          allow_resale: boolean
          allow_tenant_display: boolean
          allowed_entity_types: Database["public"]["Enums"]["directory_entity_type"][]
          allowed_purposes: string[]
          cache_scope: Database["public"]["Enums"]["provider_cache_scope"]
          connection_id: string | null
          created_at: string
          discovery_configuration: Json
          field_mapping: Json
          id: string
          integration_type: string
          license_terms: Json
          name: string
          paused_reason: string | null
          permission_document_path: string | null
          provider: string
          source_attribution_required: boolean
          source_class: string
          status: string
          tenant_id: string
          updated_at: string
          valid_from: string | null
          valid_until: string | null
        }
        Insert: {
          adapter_key?: string | null
          allow_export?: boolean
          allow_raw_storage?: boolean
          allow_resale?: boolean
          allow_tenant_display?: boolean
          allowed_entity_types?: Database["public"]["Enums"]["directory_entity_type"][]
          allowed_purposes?: string[]
          cache_scope?: Database["public"]["Enums"]["provider_cache_scope"]
          connection_id?: string | null
          created_at?: string
          discovery_configuration?: Json
          field_mapping?: Json
          id?: string
          integration_type?: string
          license_terms?: Json
          name: string
          paused_reason?: string | null
          permission_document_path?: string | null
          provider: string
          source_attribution_required?: boolean
          source_class?: string
          status?: string
          tenant_id: string
          updated_at?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Update: {
          adapter_key?: string | null
          allow_export?: boolean
          allow_raw_storage?: boolean
          allow_resale?: boolean
          allow_tenant_display?: boolean
          allowed_entity_types?: Database["public"]["Enums"]["directory_entity_type"][]
          allowed_purposes?: string[]
          cache_scope?: Database["public"]["Enums"]["provider_cache_scope"]
          connection_id?: string | null
          created_at?: string
          discovery_configuration?: Json
          field_mapping?: Json
          id?: string
          integration_type?: string
          license_terms?: Json
          name?: string
          paused_reason?: string | null
          permission_document_path?: string | null
          provider?: string
          source_attribution_required?: boolean
          source_class?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "data_providers_tenant_id_connection_id_fkey"
            columns: ["tenant_id", "connection_id"]
            isOneToOne: false
            referencedRelation: "tenant_integrations"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "data_providers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      data_quality_scores: {
        Row: {
          calculated_at: string
          completeness: number
          consistency: number
          details: Json
          freshness: number
          master_entity_id: string
          overall: number | null
          provenance: number
        }
        Insert: {
          calculated_at?: string
          completeness?: number
          consistency?: number
          details?: Json
          freshness?: number
          master_entity_id: string
          overall?: number | null
          provenance?: number
        }
        Update: {
          calculated_at?: string
          completeness?: number
          consistency?: number
          details?: Json
          freshness?: number
          master_entity_id?: string
          overall?: number | null
          provenance?: number
        }
        Relationships: [
          {
            foreignKeyName: "data_quality_scores_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: true
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      data_subject_request_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          details: Json
          event_type: string
          id: number
          request_id: string
          tenant_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json
          event_type: string
          id?: never
          request_id: string
          tenant_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json
          event_type?: string
          id?: never
          request_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_subject_request_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_subject_request_events_tenant_id_request_id_fkey"
            columns: ["tenant_id", "request_id"]
            isOneToOne: false
            referencedRelation: "data_subject_requests"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      data_subject_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          due_at: string | null
          evidence: Json
          handled_by: string | null
          id: string
          identity_verified_at: string | null
          processing_notes: string | null
          rejection_reason: string | null
          request_type: string
          result_hash: string | null
          result_storage_path: string | null
          status: string
          subject_reference: string
          tenant_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          due_at?: string | null
          evidence?: Json
          handled_by?: string | null
          id?: string
          identity_verified_at?: string | null
          processing_notes?: string | null
          rejection_reason?: string | null
          request_type: string
          result_hash?: string | null
          result_storage_path?: string | null
          status?: string
          subject_reference: string
          tenant_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          due_at?: string | null
          evidence?: Json
          handled_by?: string | null
          id?: string
          identity_verified_at?: string | null
          processing_notes?: string | null
          rejection_reason?: string | null
          request_type?: string
          result_hash?: string | null
          result_storage_path?: string | null
          status?: string
          subject_reference?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_subject_requests_customer_tenant_fk"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "data_subject_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_stage_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          deal_id: string
          from_stage_id: string | null
          id: number
          tenant_id: string
          to_stage_id: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          deal_id: string
          from_stage_id?: string | null
          id?: never
          tenant_id: string
          to_stage_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          deal_id?: string
          from_stage_id?: string | null
          id?: never
          tenant_id?: string
          to_stage_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_stage_history_tenant_id_deal_id_fkey"
            columns: ["tenant_id", "deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      deals: {
        Row: {
          competitor: string | null
          created_at: string
          currency: string
          current_supplier: string | null
          customer_id: string
          expected_close_date: string | null
          id: string
          loss_reason: string | null
          name: string
          next_activity_at: string | null
          owner_user_id: string | null
          pipeline_id: string
          probability: number
          product_id: string | null
          renewal_date: string | null
          stage_id: string
          status: Database["public"]["Enums"]["deal_status"]
          team_id: string | null
          tenant_id: string
          updated_at: string
          value: number
        }
        Insert: {
          competitor?: string | null
          created_at?: string
          currency?: string
          current_supplier?: string | null
          customer_id: string
          expected_close_date?: string | null
          id?: string
          loss_reason?: string | null
          name: string
          next_activity_at?: string | null
          owner_user_id?: string | null
          pipeline_id: string
          probability?: number
          product_id?: string | null
          renewal_date?: string | null
          stage_id: string
          status?: Database["public"]["Enums"]["deal_status"]
          team_id?: string | null
          tenant_id: string
          updated_at?: string
          value?: number
        }
        Update: {
          competitor?: string | null
          created_at?: string
          currency?: string
          current_supplier?: string | null
          customer_id?: string
          expected_close_date?: string | null
          id?: string
          loss_reason?: string | null
          name?: string
          next_activity_at?: string | null
          owner_user_id?: string | null
          pipeline_id?: string
          probability?: number
          product_id?: string | null
          renewal_date?: string | null
          stage_id?: string
          status?: Database["public"]["Enums"]["deal_status"]
          team_id?: string | null
          tenant_id?: string
          updated_at?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "deals_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_tenant_id_pipeline_id_fkey"
            columns: ["tenant_id", "pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "deals_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "deals_tenant_id_stage_id_fkey"
            columns: ["tenant_id", "stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "deals_tenant_id_team_id_fkey"
            columns: ["tenant_id", "team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      dialer_sessions: {
        Row: {
          created_at: string
          current_callback_activity_id: string | null
          current_call_id: string | null
          current_list_member_id: string | null
          ended_at: string | null
          id: string
          last_seen_at: string
          list_id: string
          mode: string
          paused_at: string | null
          started_at: string
          state: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_callback_activity_id?: string | null
          current_call_id?: string | null
          current_list_member_id?: string | null
          ended_at?: string | null
          id?: string
          last_seen_at?: string
          list_id: string
          mode: string
          paused_at?: string | null
          started_at?: string
          state?: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_callback_activity_id?: string | null
          current_call_id?: string | null
          current_list_member_id?: string | null
          ended_at?: string | null
          id?: string
          last_seen_at?: string
          list_id?: string
          mode?: string
          paused_at?: string | null
          started_at?: string
          state?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      departments: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          office_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          office_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          office_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_tenant_id_office_id_fkey"
            columns: ["tenant_id", "office_id"]
            isOneToOne: false
            referencedRelation: "offices"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      duplicate_candidates: {
        Row: {
          confidence: number
          created_at: string
          id: string
          left_entity_id: string
          match_method: string
          reviewed_at: string | null
          reviewed_by: string | null
          right_entity_id: string
          status: string
          tenant_id: string | null
        }
        Insert: {
          confidence: number
          created_at?: string
          id?: string
          left_entity_id: string
          match_method: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          right_entity_id: string
          status?: string
          tenant_id?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          id?: string
          left_entity_id?: string
          match_method?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          right_entity_id?: string
          status?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "duplicate_candidates_left_entity_id_fkey"
            columns: ["left_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_right_entity_id_fkey"
            columns: ["right_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_messages: {
        Row: {
          attachments: Json
          body_html: string | null
          body_text: string | null
          cc_addresses: string[]
          contract_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          delivered_at: string | null
          direction: Database["public"]["Enums"]["communication_direction"]
          error_message: string | null
          from_address: string
          id: string
          idempotency_key: string | null
          opened_at: string | null
          provider_message_id: string | null
          purpose: string
          sent_at: string | null
          status: Database["public"]["Enums"]["delivery_status"]
          subject: string
          template_id: string | null
          tenant_id: string
          to_addresses: string[]
          updated_at: string
        }
        Insert: {
          attachments?: Json
          body_html?: string | null
          body_text?: string | null
          cc_addresses?: string[]
          contract_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          delivered_at?: string | null
          direction?: Database["public"]["Enums"]["communication_direction"]
          error_message?: string | null
          from_address: string
          id?: string
          idempotency_key?: string | null
          opened_at?: string | null
          provider_message_id?: string | null
          purpose?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          subject: string
          template_id?: string | null
          tenant_id: string
          to_addresses: string[]
          updated_at?: string
        }
        Update: {
          attachments?: Json
          body_html?: string | null
          body_text?: string | null
          cc_addresses?: string[]
          contract_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          delivered_at?: string | null
          direction?: Database["public"]["Enums"]["communication_direction"]
          error_message?: string | null
          from_address?: string
          id?: string
          idempotency_key?: string | null
          opened_at?: string | null
          provider_message_id?: string | null
          purpose?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          subject?: string
          template_id?: string | null
          tenant_id?: string
          to_addresses?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_messages_contract_tenant_fk"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "email_messages_customer_tenant_fk"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "email_messages_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "email_messages_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "email_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      enrichment_errors: {
        Row: {
          created_at: string
          details: Json
          enrichment_job_id: string
          error_code: string | null
          id: number
          message: string
          retryable: boolean
          stage: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          details?: Json
          enrichment_job_id: string
          error_code?: string | null
          id?: never
          message: string
          retryable?: boolean
          stage: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          details?: Json
          enrichment_job_id?: string
          error_code?: string | null
          id?: never
          message?: string
          retryable?: boolean
          stage?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "enrichment_errors_tenant_id_enrichment_job_id_fkey"
            columns: ["tenant_id", "enrichment_job_id"]
            isOneToOne: false
            referencedRelation: "enrichment_jobs"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      enrichment_jobs: {
        Row: {
          actual_cost: number
          actual_external_calls: number
          attempts: number
          completed_at: string | null
          created_at: string
          data_provider_id: string
          enrichment_type: string
          estimated_cost: number
          estimated_external_calls: number
          id: string
          idempotency_key: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          master_entity_id: string | null
          max_attempts: number
          next_attempt_at: string
          permission_id: string
          permission_result: Json
          provider_account_id: string | null
          purpose: string
          quota_result: Json
          requested_by: string | null
          requested_fields: string[]
          result_summary: Json
          started_at: string | null
          status: Database["public"]["Enums"]["enrichment_state"]
          tenant_id: string
        }
        Insert: {
          actual_cost?: number
          actual_external_calls?: number
          attempts?: number
          completed_at?: string | null
          created_at?: string
          data_provider_id: string
          enrichment_type?: string
          estimated_cost?: number
          estimated_external_calls?: number
          id?: string
          idempotency_key: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          master_entity_id?: string | null
          max_attempts?: number
          next_attempt_at?: string
          permission_id: string
          permission_result?: Json
          provider_account_id?: string | null
          purpose: string
          quota_result?: Json
          requested_by?: string | null
          requested_fields?: string[]
          result_summary?: Json
          started_at?: string | null
          status?: Database["public"]["Enums"]["enrichment_state"]
          tenant_id: string
        }
        Update: {
          actual_cost?: number
          actual_external_calls?: number
          attempts?: number
          completed_at?: string | null
          created_at?: string
          data_provider_id?: string
          enrichment_type?: string
          estimated_cost?: number
          estimated_external_calls?: number
          id?: string
          idempotency_key?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          master_entity_id?: string | null
          max_attempts?: number
          next_attempt_at?: string
          permission_id?: string
          permission_result?: Json
          provider_account_id?: string | null
          purpose?: string
          quota_result?: Json
          requested_by?: string | null
          requested_fields?: string[]
          result_summary?: Json
          started_at?: string | null
          status?: Database["public"]["Enums"]["enrichment_state"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "enrichment_jobs_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrichment_jobs_tenant_id_data_provider_id_fkey"
            columns: ["tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "enrichment_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrichment_jobs_tenant_id_permission_id_fkey"
            columns: ["tenant_id", "permission_id"]
            isOneToOne: false
            referencedRelation: "provider_permissions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "enrichment_jobs_tenant_id_provider_account_id_fkey"
            columns: ["tenant_id", "provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      entity_freshness: {
        Row: {
          enriched_at: string | null
          fresh_until: string | null
          last_error: string | null
          last_refresh_completed_at: string | null
          last_refresh_started_at: string | null
          master_entity_id: string
          next_refresh_at: string | null
          state: Database["public"]["Enums"]["directory_freshness_state"]
          updated_at: string
        }
        Insert: {
          enriched_at?: string | null
          fresh_until?: string | null
          last_error?: string | null
          last_refresh_completed_at?: string | null
          last_refresh_started_at?: string | null
          master_entity_id: string
          next_refresh_at?: string | null
          state?: Database["public"]["Enums"]["directory_freshness_state"]
          updated_at?: string
        }
        Update: {
          enriched_at?: string | null
          fresh_until?: string | null
          last_error?: string | null
          last_refresh_completed_at?: string | null
          last_refresh_started_at?: string | null
          master_entity_id?: string
          next_refresh_at?: string | null
          state?: Database["public"]["Enums"]["directory_freshness_state"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_freshness_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: true
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_source_links: {
        Row: {
          confidence: number
          created_at: string
          manually_verified: boolean
          master_entity_id: string
          match_method: string
          source_entity_id: string
        }
        Insert: {
          confidence?: number
          created_at?: string
          manually_verified?: boolean
          master_entity_id: string
          match_method: string
          source_entity_id: string
        }
        Update: {
          confidence?: number
          created_at?: string
          manually_verified?: boolean
          master_entity_id?: string
          match_method?: string
          source_entity_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_source_links_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_source_links_source_entity_id_fkey"
            columns: ["source_entity_id"]
            isOneToOne: false
            referencedRelation: "source_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_packages: {
        Row: {
          acceptance_id: string | null
          contract_id: string
          contract_version_id: string
          created_at: string
          generated_at: string | null
          id: string
          manifest: Json | null
          manifest_hash: string | null
          status: string
          storage_path: string | null
          tenant_id: string
        }
        Insert: {
          acceptance_id?: string | null
          contract_id: string
          contract_version_id: string
          created_at?: string
          generated_at?: string | null
          id?: string
          manifest?: Json | null
          manifest_hash?: string | null
          status?: string
          storage_path?: string | null
          tenant_id: string
        }
        Update: {
          acceptance_id?: string | null
          contract_id?: string
          contract_version_id?: string
          created_at?: string
          generated_at?: string | null
          id?: string
          manifest?: Json | null
          manifest_hash?: string | null
          status?: string
          storage_path?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "evidence_packages_tenant_id_acceptance_id_fkey"
            columns: ["tenant_id", "acceptance_id"]
            isOneToOne: false
            referencedRelation: "contract_acceptances"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "evidence_packages_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "evidence_packages_tenant_id_contract_version_id_fkey"
            columns: ["tenant_id", "contract_version_id"]
            isOneToOne: false
            referencedRelation: "contract_versions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      field_freshness: {
        Row: {
          field_key: string
          fresh_until: string | null
          master_entity_id: string
          next_refresh_at: string | null
          state: Database["public"]["Enums"]["directory_freshness_state"]
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          field_key: string
          fresh_until?: string | null
          master_entity_id: string
          next_refresh_at?: string | null
          state?: Database["public"]["Enums"]["directory_freshness_state"]
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          field_key?: string
          fresh_until?: string | null
          master_entity_id?: string
          next_refresh_at?: string | null
          state?: Database["public"]["Enums"]["directory_freshness_state"]
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "field_freshness_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      field_value_history: {
        Row: {
          change_type: string
          changed_at: string
          field_key: string
          id: number
          master_entity_id: string
          new_value: Json | null
          old_value: Json | null
          source_fact_id: string | null
        }
        Insert: {
          change_type: string
          changed_at?: string
          field_key: string
          id?: never
          master_entity_id: string
          new_value?: Json | null
          old_value?: Json | null
          source_fact_id?: string | null
        }
        Update: {
          change_type?: string
          changed_at?: string
          field_key?: string
          id?: never
          master_entity_id?: string
          new_value?: Json | null
          old_value?: Json | null
          source_fact_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "field_value_history_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_value_history_source_fact_id_fkey"
            columns: ["source_fact_id"]
            isOneToOne: false
            referencedRelation: "source_facts"
            referencedColumns: ["id"]
          },
        ]
      }
      field_values: {
        Row: {
          confidence: number
          created_at: string
          field_key: string
          field_value: Json
          fresh_until: string | null
          id: string
          manually_verified: boolean
          master_entity_id: string
          selected_source_fact_id: string | null
          source_priority: number
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          field_key: string
          field_value: Json
          fresh_until?: string | null
          id?: string
          manually_verified?: boolean
          master_entity_id: string
          selected_source_fact_id?: string | null
          source_priority?: number
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          field_key?: string
          field_value?: Json
          fresh_until?: string | null
          id?: string
          manually_verified?: boolean
          master_entity_id?: string
          selected_source_fact_id?: string | null
          source_priority?: number
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "field_values_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_values_selected_source_fact_id_fkey"
            columns: ["selected_source_fact_id"]
            isOneToOne: false
            referencedRelation: "source_facts"
            referencedColumns: ["id"]
          },
        ]
      }
      geographic_areas: {
        Row: {
          aliases: string[]
          area_type: string
          code: string
          country_code: string
          created_at: string
          id: string
          latitude: number | null
          longitude: number | null
          metadata: Json
          name: string
          parent_code: string | null
          parent_id: string | null
          postal_code: string | null
          source: string
          source_version: string | null
          updated_at: string
          valid_from: string | null
          valid_until: string | null
        }
        Insert: {
          aliases?: string[]
          area_type: string
          code: string
          country_code?: string
          created_at?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          metadata?: Json
          name: string
          parent_code?: string | null
          parent_id?: string | null
          postal_code?: string | null
          source: string
          source_version?: string | null
          updated_at?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Update: {
          aliases?: string[]
          area_type?: string
          code?: string
          country_code?: string
          created_at?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          metadata?: Json
          name?: string
          parent_code?: string | null
          parent_id?: string | null
          postal_code?: string | null
          source?: string
          source_version?: string | null
          updated_at?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "geographic_areas_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "geographic_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      geographic_normalization_results: {
        Row: {
          confidence: number
          county_area_id: string | null
          id: string
          input_hash: string
          input_values: Json
          master_entity_id: string
          match_method: string
          municipality_area_id: string | null
          normalized_at: string
          normalized_values: Json
          postal_area_id: string | null
          tenant_id: string
        }
        Insert: {
          confidence: number
          county_area_id?: string | null
          id?: string
          input_hash: string
          input_values: Json
          master_entity_id: string
          match_method: string
          municipality_area_id?: string | null
          normalized_at?: string
          normalized_values?: Json
          postal_area_id?: string | null
          tenant_id: string
        }
        Update: {
          confidence?: number
          county_area_id?: string | null
          id?: string
          input_hash?: string
          input_values?: Json
          master_entity_id?: string
          match_method?: string
          municipality_area_id?: string | null
          normalized_at?: string
          normalized_values?: Json
          postal_area_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "geographic_normalization_results_county_area_id_fkey"
            columns: ["county_area_id"]
            isOneToOne: false
            referencedRelation: "geographic_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geographic_normalization_results_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geographic_normalization_results_municipality_area_id_fkey"
            columns: ["municipality_area_id"]
            isOneToOne: false
            referencedRelation: "geographic_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geographic_normalization_results_postal_area_id_fkey"
            columns: ["postal_area_id"]
            isOneToOne: false
            referencedRelation: "geographic_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geographic_normalization_results_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      identity_keys: {
        Row: {
          confidence: number
          created_at: string
          id: string
          key_type: string
          master_entity_id: string
          normalized_value: string
          source_entity_id: string | null
          tenant_id: string
          updated_at: string
          verified: boolean
        }
        Insert: {
          confidence?: number
          created_at?: string
          id?: string
          key_type: string
          master_entity_id: string
          normalized_value: string
          source_entity_id?: string | null
          tenant_id: string
          updated_at?: string
          verified?: boolean
        }
        Update: {
          confidence?: number
          created_at?: string
          id?: string
          key_type?: string
          master_entity_id?: string
          normalized_value?: string
          source_entity_id?: string | null
          tenant_id?: string
          updated_at?: string
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "identity_keys_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_keys_source_entity_id_fkey"
            columns: ["source_entity_id"]
            isOneToOne: false
            referencedRelation: "source_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      import_change_sets: {
        Row: { after_data: Json | null; before_data: Json | null; created_at: string; entity_id: string; entity_type: string; id: number; import_row_id: number | null; import_run_id: string; operation: string; rollback_reason: string | null; rollback_status: string; tenant_id: string }
        Insert: { after_data?: Json | null; before_data?: Json | null; created_at?: string; entity_id: string; entity_type: string; id?: never; import_row_id?: number | null; import_run_id: string; operation: string; rollback_reason?: string | null; rollback_status?: string; tenant_id: string }
        Update: { after_data?: Json | null; before_data?: Json | null; created_at?: string; entity_id?: string; entity_type?: string; id?: never; import_row_id?: number | null; import_run_id?: string; operation?: string; rollback_reason?: string | null; rollback_status?: string; tenant_id?: string }
        Relationships: []
      }
      import_field_mappings: {
        Row: { created_at: string; default_value: Json | null; id: string; import_profile_version_id: string; required: boolean; sort_order: number; source_path: string | null; target_field: string; target_scope: string; tenant_id: string; transform_chain: Json }
        Insert: { created_at?: string; default_value?: Json | null; id?: string; import_profile_version_id: string; required?: boolean; sort_order?: number; source_path?: string | null; target_field: string; target_scope: string; tenant_id: string; transform_chain?: Json }
        Update: { created_at?: string; default_value?: Json | null; id?: string; import_profile_version_id?: string; required?: boolean; sort_order?: number; source_path?: string | null; target_field?: string; target_scope?: string; tenant_id?: string; transform_chain?: Json }
        Relationships: []
      }
      import_merge_conflicts: {
        Row: { contact_person_id: string | null; created_at: string; customer_id: string | null; existing_value: Json | null; field_name: string | null; id: string; import_row_id: number | null; import_run_id: string; incoming_value: Json | null; reason: string; resolved_at: string | null; resolved_by: string | null; status: string; tenant_id: string }
        Insert: { contact_person_id?: string | null; created_at?: string; customer_id?: string | null; existing_value?: Json | null; field_name?: string | null; id?: string; import_row_id?: number | null; import_run_id: string; incoming_value?: Json | null; reason: string; resolved_at?: string | null; resolved_by?: string | null; status?: string; tenant_id: string }
        Update: { contact_person_id?: string | null; created_at?: string; customer_id?: string | null; existing_value?: Json | null; field_name?: string | null; id?: string; import_row_id?: number | null; import_run_id?: string; incoming_value?: Json | null; reason?: string; resolved_at?: string | null; resolved_by?: string | null; status?: string; tenant_id?: string }
        Relationships: []
      }
      import_profile_versions: {
        Row: { config: Json; created_at: string; created_by: string | null; field_mapping: Json; id: string; import_profile_id: string; mapping_checksum: string; tenant_id: string; version: number }
        Insert: { config?: Json; created_at?: string; created_by?: string | null; field_mapping?: Json; id?: string; import_profile_id: string; mapping_checksum: string; tenant_id: string; version: number }
        Update: { config?: Json; created_at?: string; created_by?: string | null; field_mapping?: Json; id?: string; import_profile_id?: string; mapping_checksum?: string; tenant_id?: string; version?: number }
        Relationships: []
      }
      import_profiles: {
        Row: { active: boolean; automatic_commit: boolean; created_at: string; created_by: string | null; current_version: number; format: string; header_row: number; id: string; name: string; records_path: string | null; source_provider: string; source_website: string | null; target_list_id: string | null; target_type: string; tenant_id: string; updated_at: string; updated_by: string | null; worksheet_name: string | null }
        Insert: { active?: boolean; automatic_commit?: boolean; created_at?: string; created_by?: string | null; current_version?: number; format?: string; header_row?: number; id?: string; name: string; records_path?: string | null; source_provider?: string; source_website?: string | null; target_list_id?: string | null; target_type?: string; tenant_id: string; updated_at?: string; updated_by?: string | null; worksheet_name?: string | null }
        Update: { active?: boolean; automatic_commit?: boolean; created_at?: string; created_by?: string | null; current_version?: number; format?: string; header_row?: number; id?: string; name?: string; records_path?: string | null; source_provider?: string; source_website?: string | null; target_list_id?: string | null; target_type?: string; tenant_id?: string; updated_at?: string; updated_by?: string | null; worksheet_name?: string | null }
        Relationships: []
      }
      import_run_list_targets: {
        Row: { assignment_strategy: string; created_at: string; created_by: string | null; id: string; import_run_id: string; list_id: string; settings: Json; tenant_id: string }
        Insert: { assignment_strategy?: string; created_at?: string; created_by?: string | null; id?: string; import_run_id: string; list_id: string; settings?: Json; tenant_id: string }
        Update: { assignment_strategy?: string; created_at?: string; created_by?: string | null; id?: string; import_run_id?: string; list_id?: string; settings?: Json; tenant_id?: string }
        Relationships: []
      }
      parsehub_projects: {
        Row: { active: boolean; configuration: Json; created_at: string; created_by: string | null; id: string; import_profile_id: string | null; project_name: string; project_token_hash: string; provider_account_id: string | null; source_website: string | null; tenant_id: string; updated_at: string; webhook_secret_hash: string | null }
        Insert: { active?: boolean; configuration?: Json; created_at?: string; created_by?: string | null; id?: string; import_profile_id?: string | null; project_name: string; project_token_hash: string; provider_account_id?: string | null; source_website?: string | null; tenant_id: string; updated_at?: string; webhook_secret_hash?: string | null }
        Update: { active?: boolean; configuration?: Json; created_at?: string; created_by?: string | null; id?: string; import_profile_id?: string | null; project_name?: string; project_token_hash?: string; provider_account_id?: string | null; source_website?: string | null; tenant_id?: string; updated_at?: string; webhook_secret_hash?: string | null }
        Relationships: []
      }
      parsehub_runs: {
        Row: { attempts: number; created_at: string; id: string; idempotency_key: string; import_profile_id: string | null; import_run_id: string | null; last_error_code: string | null; locked_at: string | null; locked_by: string | null; metadata: Json; next_attempt_at: string | null; parsehub_project_id: string; response_sha256: string | null; response_size_bytes: number | null; run_completed_at: string | null; run_started_at: string | null; run_token_ciphertext: string | null; run_token_hash: string; source_retrieved_at: string | null; status: string; tenant_id: string; updated_at: string; webhook_received_at: string | null }
        Insert: { attempts?: number; created_at?: string; id?: string; idempotency_key: string; import_profile_id?: string | null; import_run_id?: string | null; last_error_code?: string | null; locked_at?: string | null; locked_by?: string | null; metadata?: Json; next_attempt_at?: string | null; parsehub_project_id: string; response_sha256?: string | null; response_size_bytes?: number | null; run_completed_at?: string | null; run_started_at?: string | null; run_token_ciphertext?: string | null; run_token_hash: string; source_retrieved_at?: string | null; status?: string; tenant_id: string; updated_at?: string; webhook_received_at?: string | null }
        Update: { attempts?: number; created_at?: string; id?: string; idempotency_key?: string; import_profile_id?: string | null; import_run_id?: string | null; last_error_code?: string | null; locked_at?: string | null; locked_by?: string | null; metadata?: Json; next_attempt_at?: string | null; parsehub_project_id?: string; response_sha256?: string | null; response_size_bytes?: number | null; run_completed_at?: string | null; run_started_at?: string | null; run_token_ciphertext?: string | null; run_token_hash?: string; source_retrieved_at?: string | null; status?: string; tenant_id?: string; updated_at?: string; webhook_received_at?: string | null }
        Relationships: []
      }
      import_rows: {
        Row: { created_at: string; decision: string | null; error_code: string | null; errors: Json; id: number; import_run_id: string; matched_contact_person_id: string | null; matched_customer_id: string | null; normalized_data: Json | null; processing_batch: number | null; processing_ms: number | null; raw_data: Json; row_number: number; row_status: string; source_external_id: string | null; tenant_id: string; warning_codes: Json }
        Insert: { created_at?: string; decision?: string | null; error_code?: string | null; errors?: Json; id?: never; import_run_id: string; matched_contact_person_id?: string | null; matched_customer_id?: string | null; normalized_data?: Json | null; processing_batch?: number | null; processing_ms?: number | null; raw_data: Json; row_number: number; row_status?: string; source_external_id?: string | null; tenant_id: string; warning_codes?: Json }
        Update: { created_at?: string; decision?: string | null; error_code?: string | null; errors?: Json; id?: never; import_run_id?: string; matched_contact_person_id?: string | null; matched_customer_id?: string | null; normalized_data?: Json | null; processing_batch?: number | null; processing_ms?: number | null; raw_data?: Json; row_number?: number; row_status?: string; source_external_id?: string | null; tenant_id?: string; warning_codes?: Json }
        Relationships: []
      }
      import_runs: {
        Row: { blocked_count: number; catalog_sync_status: string; commit_approved_at: string | null; commit_approved_by: string | null; completed_at: string | null; conflict_count: number; created_at: string; duplicate_count: number; error_count: number; field_mapping: Json; file_mime_type: string | null; file_sha256: string | null; file_size_bytes: number | null; header_row: number; id: string; idempotency_key: string | null; import_profile_id: string | null; import_profile_version_id: string | null; name: string; new_contact_count: number; new_count: number; profile_snapshot: Json; profile_version: number | null; records_path: string | null; rollback_data: Json | null; scan_completed_at: string | null; scan_provider: string | null; scan_sha256: string | null; scan_status: string; simulation: boolean; source_file_path: string | null; source_project: string | null; source_provider: string; source_retrieved_at: string | null; source_run_id: string | null; source_type: string; source_website: string | null; started_at: string | null; status: Database["public"]["Enums"]["import_status"]; target_list_id: string | null; tenant_id: string; total_rows: number; unchanged_count: number; updated_at: string; updated_contact_count: number; updated_count: number; uploaded_by: string | null; validation_report: Json; warning_count: number; worksheet_name: string | null }
        Insert: { blocked_count?: number; catalog_sync_status?: string; commit_approved_at?: string | null; commit_approved_by?: string | null; completed_at?: string | null; conflict_count?: number; created_at?: string; duplicate_count?: number; error_count?: number; field_mapping?: Json; file_mime_type?: string | null; file_sha256?: string | null; file_size_bytes?: number | null; header_row?: number; id?: string; idempotency_key?: string | null; import_profile_id?: string | null; import_profile_version_id?: string | null; name: string; new_contact_count?: number; new_count?: number; profile_snapshot?: Json; profile_version?: number | null; records_path?: string | null; rollback_data?: Json | null; scan_completed_at?: string | null; scan_provider?: string | null; scan_sha256?: string | null; scan_status?: string; simulation?: boolean; source_file_path?: string | null; source_project?: string | null; source_provider?: string; source_retrieved_at?: string | null; source_run_id?: string | null; source_type: string; source_website?: string | null; started_at?: string | null; status?: Database["public"]["Enums"]["import_status"]; target_list_id?: string | null; tenant_id: string; total_rows?: number; unchanged_count?: number; updated_at?: string; updated_contact_count?: number; updated_count?: number; uploaded_by?: string | null; validation_report?: Json; warning_count?: number; worksheet_name?: string | null }
        Update: { blocked_count?: number; catalog_sync_status?: string; commit_approved_at?: string | null; commit_approved_by?: string | null; completed_at?: string | null; conflict_count?: number; created_at?: string; duplicate_count?: number; error_count?: number; field_mapping?: Json; file_mime_type?: string | null; file_sha256?: string | null; file_size_bytes?: number | null; header_row?: number; id?: string; idempotency_key?: string | null; import_profile_id?: string | null; import_profile_version_id?: string | null; name?: string; new_contact_count?: number; new_count?: number; profile_snapshot?: Json; profile_version?: number | null; records_path?: string | null; rollback_data?: Json | null; scan_completed_at?: string | null; scan_provider?: string | null; scan_sha256?: string | null; scan_status?: string; simulation?: boolean; source_file_path?: string | null; source_project?: string | null; source_provider?: string; source_retrieved_at?: string | null; source_run_id?: string | null; source_type?: string; source_website?: string | null; started_at?: string | null; status?: Database["public"]["Enums"]["import_status"]; target_list_id?: string | null; tenant_id?: string; total_rows?: number; unchanged_count?: number; updated_at?: string; updated_contact_count?: number; updated_count?: number; uploaded_by?: string | null; validation_report?: Json; warning_count?: number; worksheet_name?: string | null }
        Relationships: []
      }
      ingestion_errors: {
        Row: {
          created_at: string
          details: Json
          error_code: string | null
          id: number
          ingestion_run_id: string
          message: string
          raw_payload_id: string | null
          retryable: boolean
          stage: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          details?: Json
          error_code?: string | null
          id?: never
          ingestion_run_id: string
          message: string
          raw_payload_id?: string | null
          retryable?: boolean
          stage: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          details?: Json
          error_code?: string | null
          id?: never
          ingestion_run_id?: string
          message?: string
          raw_payload_id?: string | null
          retryable?: boolean
          stage?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_errors_tenant_id_ingestion_run_id_fkey"
            columns: ["tenant_id", "ingestion_run_id"]
            isOneToOne: false
            referencedRelation: "ingestion_runs"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "ingestion_errors_tenant_id_raw_payload_id_fkey"
            columns: ["tenant_id", "raw_payload_id"]
            isOneToOne: false
            referencedRelation: "raw_payloads"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      ingestion_jobs: {
        Row: {
          adapter_configuration: Json
          adapter_key: string
          created_at: string
          created_by: string | null
          data_provider_id: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          filter_definition: Json
          id: string
          last_completed_at: string | null
          last_scheduled_at: string | null
          max_records: number
          name: string
          next_run_at: string | null
          permission_id: string
          priority: number
          provider_account_id: string | null
          quota_interpretation: string
          schedule_expression: string | null
          schedule_interval_seconds: number
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          adapter_configuration?: Json
          adapter_key?: string
          created_at?: string
          created_by?: string | null
          data_provider_id: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          filter_definition?: Json
          id?: string
          last_completed_at?: string | null
          last_scheduled_at?: string | null
          max_records?: number
          name: string
          next_run_at?: string | null
          permission_id: string
          priority?: number
          provider_account_id?: string | null
          quota_interpretation?: string
          schedule_expression?: string | null
          schedule_interval_seconds?: number
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          adapter_configuration?: Json
          adapter_key?: string
          created_at?: string
          created_by?: string | null
          data_provider_id?: string
          entity_type?: Database["public"]["Enums"]["directory_entity_type"]
          filter_definition?: Json
          id?: string
          last_completed_at?: string | null
          last_scheduled_at?: string | null
          max_records?: number
          name?: string
          next_run_at?: string | null
          permission_id?: string
          priority?: number
          provider_account_id?: string | null
          quota_interpretation?: string
          schedule_expression?: string | null
          schedule_interval_seconds?: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_jobs_tenant_id_data_provider_id_fkey"
            columns: ["tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "ingestion_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingestion_jobs_tenant_id_permission_id_fkey"
            columns: ["tenant_id", "permission_id"]
            isOneToOne: false
            referencedRelation: "provider_permissions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "ingestion_jobs_tenant_id_provider_account_id_fkey"
            columns: ["tenant_id", "provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      ingestion_runs: {
        Row: {
          attempts: number
          changed_records: number
          completed_at: string | null
          created_at: string
          current_page: string | null
          error_records: number
          fetched_records: number
          id: string
          ingestion_job_id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          metadata: Json
          new_records: number
          next_attempt_at: string
          next_page: string | null
          parser_fingerprint: string | null
          parser_version_id: string | null
          quarantined_records: number
          quota_remaining: number | null
          requested_records: number
          started_at: string | null
          status: Database["public"]["Enums"]["ingestion_state"]
          tenant_id: string
          unchanged_records: number
        }
        Insert: {
          attempts?: number
          changed_records?: number
          completed_at?: string | null
          created_at?: string
          current_page?: string | null
          error_records?: number
          fetched_records?: number
          id?: string
          ingestion_job_id: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          metadata?: Json
          new_records?: number
          next_attempt_at?: string
          next_page?: string | null
          parser_fingerprint?: string | null
          parser_version_id?: string | null
          quarantined_records?: number
          quota_remaining?: number | null
          requested_records?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["ingestion_state"]
          tenant_id: string
          unchanged_records?: number
        }
        Update: {
          attempts?: number
          changed_records?: number
          completed_at?: string | null
          created_at?: string
          current_page?: string | null
          error_records?: number
          fetched_records?: number
          id?: string
          ingestion_job_id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          metadata?: Json
          new_records?: number
          next_attempt_at?: string
          next_page?: string | null
          parser_fingerprint?: string | null
          parser_version_id?: string | null
          quarantined_records?: number
          quota_remaining?: number | null
          requested_records?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["ingestion_state"]
          tenant_id?: string
          unchanged_records?: number
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_runs_tenant_id_ingestion_job_id_fkey"
            columns: ["tenant_id", "ingestion_job_id"]
            isOneToOne: false
            referencedRelation: "ingestion_jobs"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "ingestion_runs_tenant_id_parser_version_id_fkey"
            columns: ["tenant_id", "parser_version_id"]
            isOneToOne: false
            referencedRelation: "parser_versions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      list_dispositions: {
        Row: {
          active: boolean
          created_at: string
          id: string
          key: string
          label: string
          list_id: string
          outcome_group: string
          requires_callback: boolean
          requires_note: boolean
          requires_order: boolean
          retry_after_minutes: number | null
          sort_order: number
          tenant_id: string
          terminal: boolean
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          key: string
          label: string
          list_id: string
          outcome_group: string
          requires_callback?: boolean
          requires_note?: boolean
          requires_order?: boolean
          retry_after_minutes?: number | null
          sort_order?: number
          tenant_id: string
          terminal?: boolean
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          key?: string
          label?: string
          list_id?: string
          outcome_group?: string
          requires_callback?: boolean
          requires_note?: boolean
          requires_order?: boolean
          retry_after_minutes?: number | null
          sort_order?: number
          tenant_id?: string
          terminal?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      legal_holds: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          customer_id: string | null
          ends_at: string | null
          id: string
          master_entity_id: string | null
          reason: string
          released_at: string | null
          released_by: string | null
          scope: string[]
          starts_at: string
          tenant_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          ends_at?: string | null
          id?: string
          master_entity_id?: string | null
          reason: string
          released_at?: string | null
          released_by?: string | null
          scope?: string[]
          starts_at?: string
          tenant_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          ends_at?: string | null
          id?: string
          master_entity_id?: string | null
          reason?: string
          released_at?: string | null
          released_by?: string | null
          scope?: string[]
          starts_at?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_holds_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legal_holds_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legal_holds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      master_entities: {
        Row: {
          address_line1: string | null
          cache_scope: Database["public"]["Enums"]["provider_cache_scope"]
          canonical_name: string
          city: string | null
          country_code: string
          county: string | null
          county_code: string | null
          created_at: string
          current_master: Json
          data_provider_id: string
          data_quality_score: number
          date_of_birth: string | null
          email: string | null
          employee_count: number | null
          employer_registered: boolean | null
          enriched_at: string | null
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          external_primary_id: string | null
          f_tax_registered: boolean | null
          fresh_until: string | null
          id: string
          industry: string | null
          latitude: number | null
          legal_form: string | null
          license_tenant_id: string
          longitude: number | null
          merged_at: string | null
          merged_into_id: string | null
          municipality: string | null
          municipality_code: string | null
          next_refresh_at: string | null
          organization_number: string | null
          organization_status: string | null
          owner_tenant_id: string | null
          permission_id: string
          phone_e164: string | null
          phone_type: string | null
          postal_code: string | null
          provider_account_id: string | null
          registration_date: string | null
          result: number | null
          revenue: number | null
          sni_code: string | null
          source_removed_at: string | null
          updated_at: string
          vat_registered: boolean | null
          website: string | null
        }
        Insert: {
          address_line1?: string | null
          cache_scope: Database["public"]["Enums"]["provider_cache_scope"]
          canonical_name: string
          city?: string | null
          country_code?: string
          county?: string | null
          county_code?: string | null
          created_at?: string
          current_master?: Json
          data_provider_id: string
          data_quality_score?: number
          date_of_birth?: string | null
          email?: string | null
          employee_count?: number | null
          employer_registered?: boolean | null
          enriched_at?: string | null
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          external_primary_id?: string | null
          f_tax_registered?: boolean | null
          fresh_until?: string | null
          id?: string
          industry?: string | null
          latitude?: number | null
          legal_form?: string | null
          license_tenant_id: string
          longitude?: number | null
          merged_at?: string | null
          merged_into_id?: string | null
          municipality?: string | null
          municipality_code?: string | null
          next_refresh_at?: string | null
          organization_number?: string | null
          organization_status?: string | null
          owner_tenant_id?: string | null
          permission_id: string
          phone_e164?: string | null
          phone_type?: string | null
          postal_code?: string | null
          provider_account_id?: string | null
          registration_date?: string | null
          result?: number | null
          revenue?: number | null
          sni_code?: string | null
          source_removed_at?: string | null
          updated_at?: string
          vat_registered?: boolean | null
          website?: string | null
        }
        Update: {
          address_line1?: string | null
          cache_scope?: Database["public"]["Enums"]["provider_cache_scope"]
          canonical_name?: string
          city?: string | null
          country_code?: string
          county?: string | null
          county_code?: string | null
          created_at?: string
          current_master?: Json
          data_provider_id?: string
          data_quality_score?: number
          date_of_birth?: string | null
          email?: string | null
          employee_count?: number | null
          employer_registered?: boolean | null
          enriched_at?: string | null
          entity_type?: Database["public"]["Enums"]["directory_entity_type"]
          external_primary_id?: string | null
          f_tax_registered?: boolean | null
          fresh_until?: string | null
          id?: string
          industry?: string | null
          latitude?: number | null
          legal_form?: string | null
          license_tenant_id?: string
          longitude?: number | null
          merged_at?: string | null
          merged_into_id?: string | null
          municipality?: string | null
          municipality_code?: string | null
          next_refresh_at?: string | null
          organization_number?: string | null
          organization_status?: string | null
          owner_tenant_id?: string | null
          permission_id?: string
          phone_e164?: string | null
          phone_type?: string | null
          postal_code?: string | null
          provider_account_id?: string | null
          registration_date?: string | null
          result?: number | null
          revenue?: number | null
          sni_code?: string | null
          source_removed_at?: string | null
          updated_at?: string
          vat_registered?: boolean | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "master_entities_license_tenant_id_data_provider_id_fkey"
            columns: ["license_tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "master_entities_license_tenant_id_fkey"
            columns: ["license_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_entities_license_tenant_id_permission_id_fkey"
            columns: ["license_tenant_id", "permission_id"]
            isOneToOne: false
            referencedRelation: "provider_permissions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "master_entities_license_tenant_id_provider_account_id_fkey"
            columns: ["license_tenant_id", "provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "master_entities_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_entities_owner_tenant_id_fkey"
            columns: ["owner_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      merge_decisions: {
        Row: {
          decided_at: string
          decided_by: string | null
          decision: string
          id: string
          snapshot: Json
          source_entity_id: string
          target_entity_id: string
          tenant_id: string
          undone_at: string | null
          undone_by: string | null
        }
        Insert: {
          decided_at?: string
          decided_by?: string | null
          decision: string
          id?: string
          snapshot?: Json
          source_entity_id: string
          target_entity_id: string
          tenant_id: string
          undone_at?: string | null
          undone_by?: string | null
        }
        Update: {
          decided_at?: string
          decided_by?: string | null
          decision?: string
          id?: string
          snapshot?: Json
          source_entity_id?: string
          target_entity_id?: string
          tenant_id?: string
          undone_at?: string | null
          undone_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merge_decisions_source_entity_id_fkey"
            columns: ["source_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merge_decisions_target_entity_id_fkey"
            columns: ["target_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merge_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      message_templates: {
        Row: {
          active: boolean
          body: string
          channel: string
          created_at: string
          id: string
          name: string
          subject: string | null
          team_id: string | null
          tenant_id: string
          version: number
        }
        Insert: {
          active?: boolean
          body: string
          channel: string
          created_at?: string
          id?: string
          name: string
          subject?: string | null
          team_id?: string | null
          tenant_id: string
          version?: number
        }
        Update: {
          active?: boolean
          body?: string
          channel?: string
          created_at?: string
          id?: string
          name?: string
          subject?: string | null
          team_id?: string | null
          tenant_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "message_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_templates_tenant_id_team_id_fkey"
            columns: ["tenant_id", "team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      nix_check_jobs: {
        Row: {
          attempts: number
          completed_at: string | null
          configuration_id: string
          created_at: string
          customer_id: string
          id: string
          idempotency_key: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          next_attempt_at: string
          phone_e164: string
          requested_by: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          configuration_id: string
          created_at?: string
          customer_id: string
          id?: string
          idempotency_key: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_attempt_at?: string
          phone_e164: string
          requested_by?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          configuration_id?: string
          created_at?: string
          customer_id?: string
          id?: string
          idempotency_key?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_attempt_at?: string
          phone_e164?: string
          requested_by?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "nix_check_jobs_tenant_id_configuration_id_fkey"
            columns: ["tenant_id", "configuration_id"]
            isOneToOne: false
            referencedRelation: "nix_provider_configurations"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "nix_check_jobs_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "nix_check_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      nix_checks: {
        Row: {
          checked_at: string
          created_at: string
          customer_id: string | null
          evidence: Json
          id: string
          phone_e164: string
          result: string
          source: string
          source_version: string | null
          tenant_id: string
          valid_until: string
        }
        Insert: {
          checked_at: string
          created_at?: string
          customer_id?: string | null
          evidence?: Json
          id?: string
          phone_e164: string
          result: string
          source?: string
          source_version?: string | null
          tenant_id: string
          valid_until: string
        }
        Update: {
          checked_at?: string
          created_at?: string
          customer_id?: string | null
          evidence?: Json
          id?: string
          phone_e164?: string
          result?: string
          source?: string
          source_version?: string | null
          tenant_id?: string
          valid_until?: string
        }
        Relationships: [
          {
            foreignKeyName: "nix_checks_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "nix_checks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      nix_provider_configurations: {
        Row: {
          allowed_domains: string[]
          allowed_paths: string[]
          created_at: string
          created_by: string | null
          credentials_ciphertext: string | null
          endpoint_template: string
          id: string
          max_retries: number
          method: string
          name: string
          request_configuration: Json
          result_mapping: Json
          result_path: string
          status: string
          tenant_id: string
          timeout_ms: number
          updated_at: string
          validity_days: number
        }
        Insert: {
          allowed_domains?: string[]
          allowed_paths?: string[]
          created_at?: string
          created_by?: string | null
          credentials_ciphertext?: string | null
          endpoint_template: string
          id?: string
          max_retries?: number
          method?: string
          name: string
          request_configuration?: Json
          result_mapping?: Json
          result_path?: string
          status?: string
          tenant_id: string
          timeout_ms?: number
          updated_at?: string
          validity_days?: number
        }
        Update: {
          allowed_domains?: string[]
          allowed_paths?: string[]
          created_at?: string
          created_by?: string | null
          credentials_ciphertext?: string | null
          endpoint_template?: string
          id?: string
          max_retries?: number
          method?: string
          name?: string
          request_configuration?: Json
          result_mapping?: Json
          result_path?: string
          status?: string
          tenant_id?: string
          timeout_ms?: number
          updated_at?: string
          validity_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "nix_provider_configurations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      note_revisions: {
        Row: {
          body: string
          changed_at: string
          changed_by: string | null
          id: number
          is_pinned: boolean
          note_id: string
          tenant_id: string
          visibility: string
        }
        Insert: {
          body: string
          changed_at?: string
          changed_by?: string | null
          id?: never
          is_pinned: boolean
          note_id: string
          tenant_id: string
          visibility: string
        }
        Update: {
          body?: string
          changed_at?: string
          changed_by?: string | null
          id?: never
          is_pinned?: boolean
          note_id?: string
          tenant_id?: string
          visibility?: string
        }
        Relationships: []
      }
      notes: {
        Row: {
          archived_at: string | null
          body: string
          call_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          is_pinned: boolean
          list_id: string | null
          note_type: string
          tenant_id: string
          updated_at: string
          visibility: string
        }
        Insert: {
          archived_at?: string | null
          body: string
          call_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          is_pinned?: boolean
          list_id?: string | null
          note_type?: string
          tenant_id: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          archived_at?: string | null
          body?: string
          call_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          is_pinned?: boolean
          list_id?: string | null
          note_type?: string
          tenant_id?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      offices: {
        Row: {
          active: boolean
          address_line1: string | null
          city: string | null
          country_code: string
          created_at: string
          id: string
          name: string
          postal_code: string | null
          tenant_id: string
          timezone: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          address_line1?: string | null
          city?: string | null
          country_code?: string
          created_at?: string
          id?: string
          name: string
          postal_code?: string | null
          tenant_id: string
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          address_line1?: string | null
          city?: string | null
          country_code?: string
          created_at?: string
          id?: string
          name?: string
          postal_code?: string | null
          tenant_id?: string
          timezone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      outbox_jobs: {
        Row: {
          aggregate_id: string | null
          aggregate_type: string
          attempts: number
          available_at: string
          completed_at: string | null
          created_at: string
          id: string
          idempotency_key: string
          job_type: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          priority: number
          status: Database["public"]["Enums"]["job_status"]
          tenant_id: string
        }
        Insert: {
          aggregate_id?: string | null
          aggregate_type: string
          attempts?: number
          available_at?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          idempotency_key: string
          job_type: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload: Json
          priority?: number
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id: string
        }
        Update: {
          aggregate_id?: string | null
          aggregate_type?: string
          attempts?: number
          available_at?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string
          job_type?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbox_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      parser_observations: {
        Row: {
          created_at: string
          details: Json
          disappearance_rate: number
          id: string
          ingestion_run_id: string | null
          match_rate: number
          missing_fields: string[]
          page_fingerprint: string | null
          parser_version_id: string
          present_fields: string[]
          raw_payload_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          details?: Json
          disappearance_rate?: number
          id?: string
          ingestion_run_id?: string | null
          match_rate?: number
          missing_fields?: string[]
          page_fingerprint?: string | null
          parser_version_id: string
          present_fields?: string[]
          raw_payload_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          details?: Json
          disappearance_rate?: number
          id?: string
          ingestion_run_id?: string | null
          match_rate?: number
          missing_fields?: string[]
          page_fingerprint?: string | null
          parser_version_id?: string
          present_fields?: string[]
          raw_payload_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "parser_observations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parser_observations_tenant_id_ingestion_run_id_fkey"
            columns: ["tenant_id", "ingestion_run_id"]
            isOneToOne: false
            referencedRelation: "ingestion_runs"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "parser_observations_tenant_id_parser_version_id_fkey"
            columns: ["tenant_id", "parser_version_id"]
            isOneToOne: false
            referencedRelation: "parser_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "parser_observations_tenant_id_raw_payload_id_fkey"
            columns: ["tenant_id", "raw_payload_id"]
            isOneToOne: false
            referencedRelation: "raw_payloads"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      parser_versions: {
        Row: {
          created_at: string
          created_by: string | null
          data_provider_id: string
          disappearance_threshold: number
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          expected_fields: string[]
          fixture_storage_path: string | null
          id: string
          minimum_match_rate: number
          page_fingerprint: string | null
          status: string
          tenant_id: string
          version: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          data_provider_id: string
          disappearance_threshold?: number
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          expected_fields?: string[]
          fixture_storage_path?: string | null
          id?: string
          minimum_match_rate?: number
          page_fingerprint?: string | null
          status?: string
          tenant_id: string
          version: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          data_provider_id?: string
          disappearance_threshold?: number
          entity_type?: Database["public"]["Enums"]["directory_entity_type"]
          expected_fields?: string[]
          fixture_storage_path?: string | null
          id?: string
          minimum_match_rate?: number
          page_fingerprint?: string | null
          status?: string
          tenant_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "parser_versions_tenant_id_data_provider_id_fkey"
            columns: ["tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      phone_numbers: {
        Row: {
          assigned_team_id: string | null
          assigned_user_id: string | null
          country_code: string
          created_at: string
          id: string
          integration_id: string | null
          last_synced_at: string | null
          number_e164: string
          provider_number_id: string | null
          purpose: string | null
          routing_config: Json
          status: string
          supports_mms: boolean
          supports_sms: boolean
          supports_voice: boolean
          tenant_id: string
          updated_at: string
          webhook_token_ciphertext: string | null
          webhook_token_hash: string
        }
        Insert: {
          assigned_team_id?: string | null
          assigned_user_id?: string | null
          country_code?: string
          created_at?: string
          id?: string
          integration_id?: string | null
          last_synced_at?: string | null
          number_e164: string
          provider_number_id?: string | null
          purpose?: string | null
          routing_config?: Json
          status?: string
          supports_mms?: boolean
          supports_sms?: boolean
          supports_voice?: boolean
          tenant_id: string
          updated_at?: string
          webhook_token_ciphertext?: string | null
          webhook_token_hash: string
        }
        Update: {
          assigned_team_id?: string | null
          assigned_user_id?: string | null
          country_code?: string
          created_at?: string
          id?: string
          integration_id?: string | null
          last_synced_at?: string | null
          number_e164?: string
          provider_number_id?: string | null
          purpose?: string | null
          routing_config?: Json
          status?: string
          supports_mms?: boolean
          supports_sms?: boolean
          supports_voice?: boolean
          tenant_id?: string
          updated_at?: string
          webhook_token_ciphertext?: string | null
          webhook_token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_tenant_id_assigned_team_id_fkey"
            columns: ["tenant_id", "assigned_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "phone_numbers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phone_numbers_tenant_id_integration_id_fkey"
            columns: ["tenant_id", "integration_id"]
            isOneToOne: false
            referencedRelation: "tenant_integrations"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      pipeline_stages: {
        Row: {
          color: string
          id: string
          is_lost: boolean
          is_won: boolean
          name: string
          pipeline_id: string
          probability: number
          sort_order: number
          tenant_id: string
        }
        Insert: {
          color?: string
          id?: string
          is_lost?: boolean
          is_won?: boolean
          name: string
          pipeline_id: string
          probability?: number
          sort_order: number
          tenant_id: string
        }
        Update: {
          color?: string
          id?: string
          is_lost?: boolean
          is_won?: boolean
          name?: string
          pipeline_id?: string
          probability?: number
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_stages_tenant_id_pipeline_id_fkey"
            columns: ["tenant_id", "pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      pipelines: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          pipeline_type: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          pipeline_type?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          pipeline_type?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipelines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: number
          metadata: Json
          reason: string | null
          tenant_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: never
          metadata?: Json
          reason?: string | null
          tenant_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: never
          metadata?: Json
          reason?: string | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_memberships: {
        Row: {
          created_at: string
          created_by: string | null
          permissions: Json
          role: Database["public"]["Enums"]["platform_role"]
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          permissions?: Json
          role: Database["public"]["Enums"]["platform_role"]
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          permissions?: Json
          role?: Database["public"]["Enums"]["platform_role"]
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      product_price_versions: {
        Row: {
          active: boolean
          binding_months: number | null
          created_at: string
          currency: string
          discounts: Json
          id: string
          notice_months: number | null
          product_id: string
          recurring_fee: number
          recurring_interval: string | null
          setup_fee: number
          tenant_id: string
          valid_from: string
          valid_to: string | null
          variable_fees: Json
          version: number
        }
        Insert: {
          active?: boolean
          binding_months?: number | null
          created_at?: string
          currency?: string
          discounts?: Json
          id?: string
          notice_months?: number | null
          product_id: string
          recurring_fee?: number
          recurring_interval?: string | null
          setup_fee?: number
          tenant_id: string
          valid_from?: string
          valid_to?: string | null
          variable_fees?: Json
          version: number
        }
        Update: {
          active?: boolean
          binding_months?: number | null
          created_at?: string
          currency?: string
          discounts?: Json
          id?: string
          notice_months?: number | null
          product_id?: string
          recurring_fee?: number
          recurring_interval?: string | null
          setup_fee?: number
          tenant_id?: string
          valid_from?: string
          valid_to?: string | null
          variable_fees?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "product_price_versions_tenant_id_product_id_fkey"
            columns: ["tenant_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      products: {
        Row: {
          active: boolean
          configuration: Json
          created_at: string
          description: string | null
          id: string
          name: string
          product_type: string
          sku: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          configuration?: Json
          created_at?: string
          description?: string | null
          id?: string
          name: string
          product_type?: string
          sku?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          configuration?: Json
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          product_type?: string
          sku?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active_tenant_id: string | null
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          last_seen_at: string | null
          locale: string
          phone_e164: string | null
          updated_at: string
        }
        Insert: {
          active_tenant_id?: string | null
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          last_seen_at?: string | null
          locale?: string
          phone_e164?: string | null
          updated_at?: string
        }
        Update: {
          active_tenant_id?: string | null
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          last_seen_at?: string | null
          locale?: string
          phone_e164?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_active_tenant_id_fkey"
            columns: ["active_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_account_tenants: {
        Row: {
          created_at: string
          owner_tenant_id: string
          provider_account_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          owner_tenant_id: string
          provider_account_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          owner_tenant_id?: string
          provider_account_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_account_tenants_owner_tenant_id_provider_account__fkey"
            columns: ["owner_tenant_id", "provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "provider_account_tenants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_accounts: {
        Row: {
          configuration: Json
          created_at: string
          created_by: string | null
          credentials_ciphertext: string | null
          data_provider_id: string
          external_account_id: string | null
          id: string
          integration_id: string | null
          name: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          configuration?: Json
          created_at?: string
          created_by?: string | null
          credentials_ciphertext?: string | null
          data_provider_id: string
          external_account_id?: string | null
          id?: string
          integration_id?: string | null
          name: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          configuration?: Json
          created_at?: string
          created_by?: string | null
          credentials_ciphertext?: string | null
          data_provider_id?: string
          external_account_id?: string | null
          id?: string
          integration_id?: string | null
          name?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_accounts_tenant_id_data_provider_id_fkey"
            columns: ["tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "provider_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_accounts_tenant_id_integration_id_fkey"
            columns: ["tenant_id", "integration_id"]
            isOneToOne: false
            referencedRelation: "tenant_integrations"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      provider_field_permissions: {
        Row: {
          created_at: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          field_key: string
          id: string
          may_display: boolean
          may_export: boolean
          may_fetch: boolean
          may_filter: boolean
          may_store: boolean
          permission_id: string
          retention_days: number | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          field_key: string
          id?: string
          may_display?: boolean
          may_export?: boolean
          may_fetch?: boolean
          may_filter?: boolean
          may_store?: boolean
          permission_id: string
          retention_days?: number | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          entity_type?: Database["public"]["Enums"]["directory_entity_type"]
          field_key?: string
          id?: string
          may_display?: boolean
          may_export?: boolean
          may_fetch?: boolean
          may_filter?: boolean
          may_store?: boolean
          permission_id?: string
          retention_days?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_field_permissions_tenant_id_permission_id_fkey"
            columns: ["tenant_id", "permission_id"]
            isOneToOne: false
            referencedRelation: "provider_permissions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      provider_freshness_policies: {
        Row: {
          active: boolean
          created_at: string
          data_provider_id: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          field_key: string | null
          id: string
          stale_while_revalidate: boolean
          synchronous_before_contract: boolean
          tenant_id: string
          ttl_days: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          data_provider_id: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          field_key?: string | null
          id?: string
          stale_while_revalidate?: boolean
          synchronous_before_contract?: boolean
          tenant_id: string
          ttl_days?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          data_provider_id?: string
          entity_type?: Database["public"]["Enums"]["directory_entity_type"]
          field_key?: string | null
          id?: string
          stale_while_revalidate?: boolean
          synchronous_before_contract?: boolean
          tenant_id?: string
          ttl_days?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_freshness_policies_tenant_id_data_provider_id_fkey"
            columns: ["tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      provider_network_allowlists: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          id: string
          network: unknown
          provider: string
          valid_from: string | null
          valid_until: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          id?: string
          network: unknown
          provider: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          id?: string
          network?: unknown
          provider?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Relationships: []
      }
      provider_permissions: {
        Row: {
          allowed_domains: string[]
          allowed_entity_types: Database["public"]["Enums"]["directory_entity_type"][]
          allowed_paths: string[]
          allowed_purposes: string[]
          attribution_required: boolean
          cache_scope: Database["public"]["Enums"]["provider_cache_scope"]
          created_at: string
          created_by: string | null
          cross_tenant_reuse_allowed: boolean
          data_provider_id: string
          document_storage_path: string | null
          expires_at: string | null
          export_allowed: boolean
          id: string
          permission_name: string
          provider_account_id: string | null
          raw_storage_allowed: boolean
          resale_allowed: boolean
          retention_days: number | null
          starts_at: string | null
          status: string
          tenant_display_allowed: boolean
          tenant_id: string
          updated_at: string
          written_approval_reference: string | null
        }
        Insert: {
          allowed_domains?: string[]
          allowed_entity_types?: Database["public"]["Enums"]["directory_entity_type"][]
          allowed_paths?: string[]
          allowed_purposes?: string[]
          attribution_required?: boolean
          cache_scope: Database["public"]["Enums"]["provider_cache_scope"]
          created_at?: string
          created_by?: string | null
          cross_tenant_reuse_allowed?: boolean
          data_provider_id: string
          document_storage_path?: string | null
          expires_at?: string | null
          export_allowed?: boolean
          id?: string
          permission_name: string
          provider_account_id?: string | null
          raw_storage_allowed?: boolean
          resale_allowed?: boolean
          retention_days?: number | null
          starts_at?: string | null
          status?: string
          tenant_display_allowed?: boolean
          tenant_id: string
          updated_at?: string
          written_approval_reference?: string | null
        }
        Update: {
          allowed_domains?: string[]
          allowed_entity_types?: Database["public"]["Enums"]["directory_entity_type"][]
          allowed_paths?: string[]
          allowed_purposes?: string[]
          attribution_required?: boolean
          cache_scope?: Database["public"]["Enums"]["provider_cache_scope"]
          created_at?: string
          created_by?: string | null
          cross_tenant_reuse_allowed?: boolean
          data_provider_id?: string
          document_storage_path?: string | null
          expires_at?: string | null
          export_allowed?: boolean
          id?: string
          permission_name?: string
          provider_account_id?: string | null
          raw_storage_allowed?: boolean
          resale_allowed?: boolean
          retention_days?: number | null
          starts_at?: string | null
          status?: string
          tenant_display_allowed?: boolean
          tenant_id?: string
          updated_at?: string
          written_approval_reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_permissions_tenant_id_data_provider_id_fkey"
            columns: ["tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "provider_permissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_permissions_tenant_id_provider_account_id_fkey"
            columns: ["tenant_id", "provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      provider_rate_limits: {
        Row: {
          allowed_end_time: string | null
          allowed_start_time: string | null
          created_at: string
          id: string
          max_concurrency: number
          max_retries: number
          max_units: number
          minimum_delay_ms: number
          provider_account_id: string
          quota_key: string
          tenant_id: string
          timeout_ms: number
          updated_at: string
          window_seconds: number
        }
        Insert: {
          allowed_end_time?: string | null
          allowed_start_time?: string | null
          created_at?: string
          id?: string
          max_concurrency?: number
          max_retries?: number
          max_units: number
          minimum_delay_ms?: number
          provider_account_id: string
          quota_key: string
          tenant_id: string
          timeout_ms?: number
          updated_at?: string
          window_seconds: number
        }
        Update: {
          allowed_end_time?: string | null
          allowed_start_time?: string | null
          created_at?: string
          id?: string
          max_concurrency?: number
          max_retries?: number
          max_units?: number
          minimum_delay_ms?: number
          provider_account_id?: string
          quota_key?: string
          tenant_id?: string
          timeout_ms?: number
          updated_at?: string
          window_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "provider_rate_limits_tenant_id_provider_account_id_fkey"
            columns: ["tenant_id", "provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      provider_usage_counters: {
        Row: {
          provider_account_id: string
          quota_key: string
          tenant_id: string
          updated_at: string
          used_units: number
          window_started_at: string
        }
        Insert: {
          provider_account_id: string
          quota_key: string
          tenant_id: string
          updated_at?: string
          used_units?: number
          window_started_at: string
        }
        Update: {
          provider_account_id?: string
          quota_key?: string
          tenant_id?: string
          updated_at?: string
          used_units?: number
          window_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_usage_counters_tenant_id_provider_account_id_fkey"
            columns: ["tenant_id", "provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      provider_usage_logs: {
        Row: {
          action: string
          cost: number | null
          created_at: string
          data_provider_id: string
          external_reference: string | null
          id: number
          metadata: Json
          purpose: string | null
          tenant_id: string
          units: number
          user_id: string | null
        }
        Insert: {
          action: string
          cost?: number | null
          created_at?: string
          data_provider_id: string
          external_reference?: string | null
          id?: never
          metadata?: Json
          purpose?: string | null
          tenant_id: string
          units?: number
          user_id?: string | null
        }
        Update: {
          action?: string
          cost?: number | null
          created_at?: string
          data_provider_id?: string
          external_reference?: string | null
          id?: never
          metadata?: Json
          purpose?: string | null
          tenant_id?: string
          units?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_usage_logs_tenant_id_data_provider_id_fkey"
            columns: ["tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      provider_webhook_events: {
        Row: {
          attempts: number
          event_type: string
          headers: Json
          id: string
          last_error: string | null
          payload: Json
          processed_at: string | null
          provider: string
          provider_event_id: string | null
          received_at: string
          route_key: string | null
          status: string
          tenant_id: string | null
        }
        Insert: {
          attempts?: number
          event_type: string
          headers?: Json
          id?: string
          last_error?: string | null
          payload: Json
          processed_at?: string | null
          provider: string
          provider_event_id?: string | null
          received_at?: string
          route_key?: string | null
          status?: string
          tenant_id?: string | null
        }
        Update: {
          attempts?: number
          event_type?: string
          headers?: Json
          id?: string
          last_error?: string | null
          payload?: Json
          processed_at?: string | null
          provider?: string
          provider_event_id?: string | null
          received_at?: string
          route_key?: string | null
          status?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_webhook_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      queue_members: {
        Row: {
          paused: boolean
          priority: number
          queue_id: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          paused?: boolean
          priority?: number
          queue_id: string
          tenant_id: string
          user_id: string
        }
        Update: {
          paused?: boolean
          priority?: number
          queue_id?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "queue_members_tenant_id_queue_id_fkey"
            columns: ["tenant_id", "queue_id"]
            isOneToOne: false
            referencedRelation: "call_queues"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "queue_members_tenant_id_user_id_fkey"
            columns: ["tenant_id", "user_id"]
            isOneToOne: false
            referencedRelation: "tenant_memberships"
            referencedColumns: ["tenant_id", "user_id"]
          },
        ]
      }
      rate_limit_counters: {
        Row: {
          bucket_key: string
          request_count: number
          tenant_id: string
          window_started_at: string
        }
        Insert: {
          bucket_key: string
          request_count?: number
          tenant_id: string
          window_started_at: string
        }
        Update: {
          bucket_key?: string
          request_count?: number
          tenant_id?: string
          window_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_limit_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_payloads: {
        Row: {
          content_type: string
          enrichment_job_id: string | null
          external_identifier: string | null
          fetched_at: string
          http_status: number | null
          id: string
          ingestion_run_id: string | null
          metadata: Json
          parse_error: string | null
          parse_status: string
          parser_version_id: string | null
          payload_ciphertext: string | null
          payload_sha256: string
          permission_id: string
          request_id: string | null
          response_headers: Json
          retention_until: string | null
          source_timestamp: string | null
          storage_path: string | null
          tenant_id: string
        }
        Insert: {
          content_type: string
          enrichment_job_id?: string | null
          external_identifier?: string | null
          fetched_at?: string
          http_status?: number | null
          id?: string
          ingestion_run_id?: string | null
          metadata?: Json
          parse_error?: string | null
          parse_status?: string
          parser_version_id?: string | null
          payload_ciphertext?: string | null
          payload_sha256: string
          permission_id: string
          request_id?: string | null
          response_headers?: Json
          retention_until?: string | null
          source_timestamp?: string | null
          storage_path?: string | null
          tenant_id: string
        }
        Update: {
          content_type?: string
          enrichment_job_id?: string | null
          external_identifier?: string | null
          fetched_at?: string
          http_status?: number | null
          id?: string
          ingestion_run_id?: string | null
          metadata?: Json
          parse_error?: string | null
          parse_status?: string
          parser_version_id?: string | null
          payload_ciphertext?: string | null
          payload_sha256?: string
          permission_id?: string
          request_id?: string | null
          response_headers?: Json
          retention_until?: string | null
          source_timestamp?: string | null
          storage_path?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "raw_payloads_enrichment_job_tenant_fk"
            columns: ["tenant_id", "enrichment_job_id"]
            isOneToOne: false
            referencedRelation: "enrichment_jobs"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "raw_payloads_tenant_id_ingestion_run_id_fkey"
            columns: ["tenant_id", "ingestion_run_id"]
            isOneToOne: false
            referencedRelation: "ingestion_runs"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "raw_payloads_tenant_id_parser_version_id_fkey"
            columns: ["tenant_id", "parser_version_id"]
            isOneToOne: false
            referencedRelation: "parser_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "raw_payloads_tenant_id_permission_id_fkey"
            columns: ["tenant_id", "permission_id"]
            isOneToOne: false
            referencedRelation: "provider_permissions"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      recording_access_logs: {
        Row: {
          created_at: string
          id: number
          ip_address: unknown
          reason: string
          recording_id: string
          tenant_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: never
          ip_address?: unknown
          reason: string
          recording_id: string
          tenant_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: never
          ip_address?: unknown
          reason?: string
          recording_id?: string
          tenant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recording_access_logs_tenant_id_recording_id_fkey"
            columns: ["tenant_id", "recording_id"]
            isOneToOne: false
            referencedRelation: "call_recordings"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      refresh_locks: {
        Row: {
          created_at: string
          enrichment_job_id: string | null
          lock_key: string
          locked_by: string
          locked_until: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          enrichment_job_id?: string | null
          lock_key: string
          locked_by: string
          locked_until: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          enrichment_job_id?: string | null
          lock_key?: string
          locked_by?: string
          locked_until?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "refresh_locks_tenant_id_enrichment_job_id_fkey"
            columns: ["tenant_id", "enrichment_job_id"]
            isOneToOne: false
            referencedRelation: "enrichment_jobs"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "refresh_locks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      retention_policies: {
        Row: {
          action: string
          active: boolean
          created_at: string
          data_category: string
          data_provider_id: string | null
          id: string
          legal_basis: string | null
          purpose: string
          retention_days: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          action?: string
          active?: boolean
          created_at?: string
          data_category: string
          data_provider_id?: string | null
          id?: string
          legal_basis?: string | null
          purpose: string
          retention_days: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          action?: string
          active?: boolean
          created_at?: string
          data_category?: string
          data_provider_id?: string | null
          id?: string
          legal_basis?: string | null
          purpose?: string
          retention_days?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "retention_policies_tenant_id_data_provider_id_fkey"
            columns: ["tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "retention_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      retention_runs: {
        Row: {
          anonymized_count: number
          archived_count: number
          completed_at: string | null
          deleted_count: number
          details: Json
          id: string
          last_error: string | null
          started_at: string
          status: string
          tenant_id: string
        }
        Insert: {
          anonymized_count?: number
          archived_count?: number
          completed_at?: string | null
          deleted_count?: number
          details?: Json
          id?: string
          last_error?: string | null
          started_at?: string
          status?: string
          tenant_id: string
        }
        Update: {
          anonymized_count?: number
          archived_count?: number
          completed_at?: string | null
          deleted_count?: number
          details?: Json
          id?: string
          last_error?: string | null
          started_at?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "retention_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      security_events: {
        Row: {
          created_at: string
          event_type: string
          id: number
          ip_address: unknown
          metadata: Json
          severity: string
          tenant_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: never
          ip_address?: unknown
          metadata?: Json
          severity?: string
          tenant_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: never
          ip_address?: unknown
          metadata?: Json
          severity?: string
          tenant_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "security_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      segment_memberships: {
        Row: {
          master_entity_id: string
          matched_at: string
          segment_id: string
          snapshot_id: string
          tenant_id: string
        }
        Insert: {
          master_entity_id: string
          matched_at?: string
          segment_id: string
          snapshot_id: string
          tenant_id: string
        }
        Update: {
          master_entity_id?: string
          matched_at?: string
          segment_id?: string
          snapshot_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "segment_memberships_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segment_memberships_tenant_id_segment_id_fkey"
            columns: ["tenant_id", "segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "segment_memberships_tenant_id_snapshot_id_fkey"
            columns: ["tenant_id", "snapshot_id"]
            isOneToOne: false
            referencedRelation: "segment_snapshots"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      segment_refresh_jobs: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          next_attempt_at: string
          reason: string
          segment_id: string
          status: string
          tenant_id: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_attempt_at?: string
          reason?: string
          segment_id: string
          status?: string
          tenant_id: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_attempt_at?: string
          reason?: string
          segment_id?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "segment_refresh_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segment_refresh_jobs_tenant_id_segment_id_fkey"
            columns: ["tenant_id", "segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      segment_rules: {
        Row: {
          comparison_value: Json | null
          created_at: string
          field_key: string
          group_number: number
          id: string
          operator: string
          segment_id: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          comparison_value?: Json | null
          created_at?: string
          field_key: string
          group_number?: number
          id?: string
          operator: string
          segment_id: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          comparison_value?: Json | null
          created_at?: string
          field_key?: string
          group_number?: number
          id?: string
          operator?: string
          segment_id?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "segment_rules_tenant_id_segment_id_fkey"
            columns: ["tenant_id", "segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      segment_snapshots: {
        Row: {
          generated_at: string
          generated_by: string | null
          id: string
          member_count: number
          rule_definition: Json
          segment_id: string
          tenant_id: string
        }
        Insert: {
          generated_at?: string
          generated_by?: string | null
          id?: string
          member_count?: number
          rule_definition: Json
          segment_id: string
          tenant_id: string
        }
        Update: {
          generated_at?: string
          generated_by?: string | null
          id?: string
          member_count?: number
          rule_definition?: Json
          segment_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "segment_snapshots_tenant_id_segment_id_fkey"
            columns: ["tenant_id", "segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      sales_order_items: {
        Row: {
          created_at: string
          description: string
          discount: number
          id: string
          line_total: number
          order_id: string
          price_version_id: string | null
          product_id: string | null
          quantity: number
          tenant_id: string
          unit_price: number
        }
        Insert: {
          created_at?: string
          description: string
          discount?: number
          id?: string
          line_total?: number
          order_id: string
          price_version_id?: string | null
          product_id?: string | null
          quantity?: number
          tenant_id: string
          unit_price?: number
        }
        Update: {
          created_at?: string
          description?: string
          discount?: number
          id?: string
          line_total?: number
          order_id?: string
          price_version_id?: string | null
          product_id?: string | null
          quantity?: number
          tenant_id?: string
          unit_price?: number
        }
        Relationships: []
      }
      sales_orders: {
        Row: {
          confirmed_at: string | null
          created_at: string
          currency: string
          customer_id: string
          discount_total: number
          id: string
          notes: string | null
          order_number: string
          owner_user_id: string | null
          source_call_id: string | null
          source_list_id: string | null
          status: string
          subtotal: number
          tenant_id: string
          total: number
          updated_at: string
        }
        Insert: {
          confirmed_at?: string | null
          created_at?: string
          currency?: string
          customer_id: string
          discount_total?: number
          id?: string
          notes?: string | null
          order_number: string
          owner_user_id?: string | null
          source_call_id?: string | null
          source_list_id?: string | null
          status?: string
          subtotal?: number
          tenant_id: string
          total?: number
          updated_at?: string
        }
        Update: {
          confirmed_at?: string | null
          created_at?: string
          currency?: string
          customer_id?: string
          discount_total?: number
          id?: string
          notes?: string | null
          order_number?: string
          owner_user_id?: string | null
          source_call_id?: string | null
          source_list_id?: string | null
          status?: string
          subtotal?: number
          tenant_id?: string
          total?: number
          updated_at?: string
        }
        Relationships: []
      }
      segments: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          id: string
          last_refreshed_at: string | null
          name: string
          owner_user_id: string | null
          rule_definition: Json
          segment_type: string
          team_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          id?: string
          last_refreshed_at?: string | null
          name: string
          owner_user_id?: string | null
          rule_definition?: Json
          segment_type?: string
          team_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          entity_type?: Database["public"]["Enums"]["directory_entity_type"]
          id?: string
          last_refreshed_at?: string | null
          name?: string
          owner_user_id?: string | null
          rule_definition?: Json
          segment_type?: string
          team_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "segments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_tenant_id_team_id_fkey"
            columns: ["tenant_id", "team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      sms_conversations: {
        Row: {
          assigned_team_id: string | null
          assigned_user_id: string | null
          created_at: string
          customer_id: string | null
          external_number: string
          id: string
          last_message_at: string | null
          phone_number_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          assigned_team_id?: string | null
          assigned_user_id?: string | null
          created_at?: string
          customer_id?: string | null
          external_number: string
          id?: string
          last_message_at?: string | null
          phone_number_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          assigned_team_id?: string | null
          assigned_user_id?: string | null
          created_at?: string
          customer_id?: string | null
          external_number?: string
          id?: string
          last_message_at?: string | null
          phone_number_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_conversations_tenant_id_assigned_team_id_fkey"
            columns: ["tenant_id", "assigned_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sms_conversations_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sms_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_conversations_tenant_id_phone_number_id_fkey"
            columns: ["tenant_id", "phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      sms_delivery_events: {
        Row: {
          id: number
          occurred_at: string
          payload: Json
          provider_event_id: string | null
          sms_message_id: string
          status: string
          tenant_id: string
        }
        Insert: {
          id?: never
          occurred_at?: string
          payload?: Json
          provider_event_id?: string | null
          sms_message_id: string
          status: string
          tenant_id: string
        }
        Update: {
          id?: never
          occurred_at?: string
          payload?: Json
          provider_event_id?: string | null
          sms_message_id?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_delivery_events_tenant_id_sms_message_id_fkey"
            columns: ["tenant_id", "sms_message_id"]
            isOneToOne: false
            referencedRelation: "sms_messages"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      sms_messages: {
        Row: {
          body: string
          contract_id: string | null
          conversation_id: string | null
          cost: number | null
          created_at: string
          created_by: string | null
          currency: string | null
          customer_id: string | null
          delivered_at: string | null
          direction: Database["public"]["Enums"]["communication_direction"]
          error_code: string | null
          error_message: string | null
          from_number: string
          id: string
          idempotency_key: string | null
          parts: number | null
          provider_message_id: string | null
          purpose: string
          sent_at: string | null
          status: Database["public"]["Enums"]["delivery_status"]
          tenant_id: string
          to_number: string
          updated_at: string
        }
        Insert: {
          body: string
          contract_id?: string | null
          conversation_id?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          customer_id?: string | null
          delivered_at?: string | null
          direction: Database["public"]["Enums"]["communication_direction"]
          error_code?: string | null
          error_message?: string | null
          from_number: string
          id?: string
          idempotency_key?: string | null
          parts?: number | null
          provider_message_id?: string | null
          purpose?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          tenant_id: string
          to_number: string
          updated_at?: string
        }
        Update: {
          body?: string
          contract_id?: string | null
          conversation_id?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          customer_id?: string | null
          delivered_at?: string | null
          direction?: Database["public"]["Enums"]["communication_direction"]
          error_code?: string | null
          error_message?: string | null
          from_number?: string
          id?: string
          idempotency_key?: string | null
          parts?: number | null
          provider_message_id?: string | null
          purpose?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          tenant_id?: string
          to_number?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_messages_contract_tenant_fk"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sms_messages_customer_tenant_fk"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sms_messages_tenant_id_contract_id_fkey"
            columns: ["tenant_id", "contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sms_messages_tenant_id_conversation_id_fkey"
            columns: ["tenant_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "sms_conversations"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sms_messages_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sms_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      source_entities: {
        Row: {
          data_provider_id: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          external_identifier: string
          first_seen_at: string
          id: string
          last_seen_at: string
          metadata: Json
          owner_tenant_id: string
          parser_version_id: string | null
          permission_id: string
          provider_account_id: string | null
          raw_payload_id: string | null
          removed_at: string | null
        }
        Insert: {
          data_provider_id: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          external_identifier: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          metadata?: Json
          owner_tenant_id: string
          parser_version_id?: string | null
          permission_id: string
          provider_account_id?: string | null
          raw_payload_id?: string | null
          removed_at?: string | null
        }
        Update: {
          data_provider_id?: string
          entity_type?: Database["public"]["Enums"]["directory_entity_type"]
          external_identifier?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          metadata?: Json
          owner_tenant_id?: string
          parser_version_id?: string | null
          permission_id?: string
          provider_account_id?: string | null
          raw_payload_id?: string | null
          removed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_entities_owner_tenant_id_data_provider_id_fkey"
            columns: ["owner_tenant_id", "data_provider_id"]
            isOneToOne: false
            referencedRelation: "data_providers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "source_entities_owner_tenant_id_fkey"
            columns: ["owner_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_entities_owner_tenant_id_parser_version_id_fkey"
            columns: ["owner_tenant_id", "parser_version_id"]
            isOneToOne: false
            referencedRelation: "parser_versions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "source_entities_owner_tenant_id_permission_id_fkey"
            columns: ["owner_tenant_id", "permission_id"]
            isOneToOne: false
            referencedRelation: "provider_permissions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "source_entities_owner_tenant_id_provider_account_id_fkey"
            columns: ["owner_tenant_id", "provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "source_entities_owner_tenant_id_raw_payload_id_fkey"
            columns: ["owner_tenant_id", "raw_payload_id"]
            isOneToOne: false
            referencedRelation: "raw_payloads"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      source_facts: {
        Row: {
          confidence: number
          created_at: string
          fetched_at: string
          field_key: string
          field_value: Json
          id: string
          last_seen_at: string
          parser_version_id: string | null
          permission_id: string
          removed_at: string | null
          source_entity_id: string
          value_hash: string
          verified_at: string | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          fetched_at: string
          field_key: string
          field_value: Json
          id?: string
          last_seen_at: string
          parser_version_id?: string | null
          permission_id: string
          removed_at?: string | null
          source_entity_id: string
          value_hash: string
          verified_at?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          fetched_at?: string
          field_key?: string
          field_value?: Json
          id?: string
          last_seen_at?: string
          parser_version_id?: string | null
          permission_id?: string
          removed_at?: string | null
          source_entity_id?: string
          value_hash?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_facts_source_entity_id_fkey"
            columns: ["source_entity_id"]
            isOneToOne: false
            referencedRelation: "source_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      source_priority_policies: {
        Row: {
          active: boolean
          created_at: string
          field_key: string
          id: string
          priority: number
          source_class: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          field_key?: string
          id?: string
          priority: number
          source_class: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          field_key?: string
          id?: string
          priority?: number
          source_class?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_priority_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      tags: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          tenant_id: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          tenant_id: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      team_features: {
        Row: {
          configuration: Json
          enabled: boolean
          feature_key: string
          team_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          configuration?: Json
          enabled?: boolean
          feature_key: string
          team_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          configuration?: Json
          enabled?: boolean
          feature_key?: string
          team_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_features_tenant_id_team_id_fkey"
            columns: ["tenant_id", "team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      team_members: {
        Row: {
          capacity: number
          created_at: string
          role: string
          team_id: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          capacity?: number
          created_at?: string
          role?: string
          team_id: string
          tenant_id: string
          user_id: string
        }
        Update: {
          capacity?: number
          created_at?: string
          role?: string
          team_id?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_tenant_id_team_id_fkey"
            columns: ["tenant_id", "team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "team_members_tenant_id_user_id_fkey"
            columns: ["tenant_id", "user_id"]
            isOneToOne: false
            referencedRelation: "tenant_memberships"
            referencedColumns: ["tenant_id", "user_id"]
          },
        ]
      }
      teams: {
        Row: {
          created_at: string
          department: string | null
          department_id: string | null
          description: string | null
          id: string
          is_default: boolean
          name: string
          office: string | null
          office_id: string | null
          settings: Json
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          department?: string | null
          department_id?: string | null
          description?: string | null
          id?: string
          is_default?: boolean
          name: string
          office?: string | null
          office_id?: string | null
          settings?: Json
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          department?: string | null
          department_id?: string | null
          description?: string | null
          id?: string
          is_default?: boolean
          name?: string
          office?: string | null
          office_id?: string | null
          settings?: Json
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_department_tenant_fk"
            columns: ["tenant_id", "department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "teams_office_tenant_fk"
            columns: ["tenant_id", "office_id"]
            isOneToOne: false
            referencedRelation: "offices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "teams_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_entities: {
        Row: {
          created_at: string
          created_by: string | null
          customer_id: string | null
          master_entity_id: string
          relationship: string
          source: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          master_entity_id: string
          relationship?: string
          source?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          master_entity_id?: string
          relationship?: string
          source?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_entities_master_entity_id_fkey"
            columns: ["master_entity_id"]
            isOneToOne: false
            referencedRelation: "master_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_entities_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "tenant_entities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_features: {
        Row: {
          configuration: Json
          enabled: boolean
          feature_key: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          configuration?: Json
          enabled?: boolean
          feature_key: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          configuration?: Json
          enabled?: boolean
          feature_key?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_features_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_integrations: {
        Row: {
          configuration: Json
          created_at: string
          created_by: string | null
          credentials_ciphertext: string | null
          id: string
          last_verified_at: string | null
          name: string
          provider: string
          provider_type: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          configuration?: Json
          created_at?: string
          created_by?: string | null
          credentials_ciphertext?: string | null
          id?: string
          last_verified_at?: string | null
          name: string
          provider: string
          provider_type: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          configuration?: Json
          created_at?: string
          created_by?: string | null
          credentials_ciphertext?: string | null
          id?: string
          last_verified_at?: string | null
          name?: string
          provider?: string
          provider_type?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_integrations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_legal_entities: {
        Row: {
          active: boolean
          address_line1: string | null
          branding: Json
          city: string | null
          country_code: string
          created_at: string
          email: string | null
          id: string
          is_default: boolean
          legal_metadata: Json
          legal_name: string
          organization_number: string | null
          phone_e164: string | null
          postal_code: string | null
          tenant_id: string
          updated_at: string
          website: string | null
        }
        Insert: {
          active?: boolean
          address_line1?: string | null
          branding?: Json
          city?: string | null
          country_code?: string
          created_at?: string
          email?: string | null
          id?: string
          is_default?: boolean
          legal_metadata?: Json
          legal_name: string
          organization_number?: string | null
          phone_e164?: string | null
          postal_code?: string | null
          tenant_id: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          active?: boolean
          address_line1?: string | null
          branding?: Json
          city?: string | null
          country_code?: string
          created_at?: string
          email?: string | null
          id?: string
          is_default?: boolean
          legal_metadata?: Json
          legal_name?: string
          organization_number?: string | null
          phone_e164?: string | null
          postal_code?: string | null
          tenant_id?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_legal_entities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_memberships: {
        Row: {
          created_at: string
          invited_at: string | null
          invited_by: string | null
          joined_at: string | null
          permissions_override: Json
          role: Database["public"]["Enums"]["membership_role"]
          status: Database["public"]["Enums"]["membership_status"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          invited_at?: string | null
          invited_by?: string | null
          joined_at?: string | null
          permissions_override?: Json
          role?: Database["public"]["Enums"]["membership_role"]
          status?: Database["public"]["Enums"]["membership_status"]
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          invited_at?: string | null
          invited_by?: string | null
          joined_at?: string | null
          permissions_override?: Json
          role?: Database["public"]["Enums"]["membership_role"]
          status?: Database["public"]["Enums"]["membership_status"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_settings: {
        Row: {
          compliance: Json
          created_at: string
          retention: Json
          settings: Json
          tenant_id: string
          updated_at: string
        }
        Insert: {
          compliance?: Json
          created_at?: string
          retention?: Json
          settings?: Json
          tenant_id: string
          updated_at?: string
        }
        Update: {
          compliance?: Json
          created_at?: string
          retention?: Json
          settings?: Json
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          branding: Json
          country_code: string
          created_at: string
          id: string
          legal_name: string
          locale: string
          name: string
          organization_number: string | null
          slug: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          branding?: Json
          country_code?: string
          created_at?: string
          id?: string
          legal_name: string
          locale?: string
          name: string
          organization_number?: string | null
          slug: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          branding?: Json
          country_code?: string
          created_at?: string
          id?: string
          legal_name?: string
          locale?: string
          name?: string
          organization_number?: string | null
          slug?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      usage_limits: {
        Row: {
          current_value: number
          hard_limit: number | null
          metric: string
          period: string
          period_started_at: string
          soft_limit: number | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          current_value?: number
          hard_limit?: number | null
          metric: string
          period?: string
          period_started_at?: string
          soft_limit?: number | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          current_value?: number
          hard_limit?: number | null
          metric?: string
          period?: string
          period_started_at?: string
          soft_limit?: number | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_limits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_clients: {
        Row: {
          assigned_user_id: string
          client_number_e164: string
          created_at: string
          id: string
          integration_id: string | null
          sip_domain: string
          sip_password_ciphertext: string
          sip_username: string
          status: string
          tenant_id: string
          updated_at: string
          websocket_url: string
        }
        Insert: {
          assigned_user_id: string
          client_number_e164: string
          created_at?: string
          id?: string
          integration_id?: string | null
          sip_domain?: string
          sip_password_ciphertext: string
          sip_username: string
          status?: string
          tenant_id: string
          updated_at?: string
          websocket_url?: string
        }
        Update: {
          assigned_user_id?: string
          client_number_e164?: string
          created_at?: string
          id?: string
          integration_id?: string | null
          sip_domain?: string
          sip_password_ciphertext?: string
          sip_username?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          websocket_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_clients_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_clients_tenant_id_integration_id_fkey"
            columns: ["tenant_id", "integration_id"]
            isOneToOne: false
            referencedRelation: "tenant_integrations"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      webhook_deliveries: {
        Row: {
          attempts: number
          created_at: string
          endpoint_id: string
          event_id: string
          event_type: string
          id: string
          next_attempt_at: string | null
          payload: Json
          response_body: string | null
          response_status: number | null
          status: Database["public"]["Enums"]["job_status"]
          tenant_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          endpoint_id: string
          event_id: string
          event_type: string
          id?: string
          next_attempt_at?: string | null
          payload: Json
          response_body?: string | null
          response_status?: number | null
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          endpoint_id?: string
          event_id?: string
          event_type?: string
          id?: string
          next_attempt_at?: string | null
          payload?: Json
          response_body?: string | null
          response_status?: number | null
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_tenant_id_endpoint_id_fkey"
            columns: ["tenant_id", "endpoint_id"]
            isOneToOne: false
            referencedRelation: "webhook_endpoints"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      webhook_endpoints: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          id: string
          name: string
          secret_ciphertext: string
          subscribed_events: string[]
          tenant_id: string
          updated_at: string
          url: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          secret_ciphertext: string
          subscribed_events: string[]
          tenant_id: string
          updated_at?: string
          url: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          secret_ciphertext?: string
          subscribed_events?: string[]
          tenant_id?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_endpoints_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      activate_automation: {
        Args: { p_automation_id: string }
        Returns: undefined
      }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      anonymize_customer_record: {
        Args: {
          p_actor?: string
          p_customer_id: string
          p_reason: string
          p_tenant_id: string
        }
        Returns: Json
      }
      apply_geographic_derived_value: {
        Args: {
          p_confidence?: number
          p_entity_id: string
          p_field_key: string
          p_permission_id: string
          p_source_entity_id: string
          p_value: Json
        }
        Returns: boolean
      }
      approve_contract_template_version: {
        Args: { p_version_id: string }
        Returns: undefined
      }
      can_access_call: { Args: { p_call_id: string }; Returns: boolean }
      can_access_contract: { Args: { p_contract_id: string }; Returns: boolean }
      can_access_customer: { Args: { p_customer_id: string }; Returns: boolean }
      can_access_master_entity: {
        Args: {
          p_entity: Database["public"]["Tables"]["master_entities"]["Row"]
        }
        Returns: boolean
      }
      can_write_contract: {
        Args: { p_contract_id?: string; p_customer_id?: string }
        Returns: boolean
      }
      can_write_customer: { Args: { p_customer_id?: string }; Returns: boolean }
      claim_automation_runs: {
        Args: { p_limit?: number; p_worker: string }
        Returns: {
          attempts: number
          automation_id: string
          available_at: string
          completed_at: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          error: string | null
          id: string
          input: Json
          locked_at: string | null
          locked_by: string | null
          output: Json | null
          priority: number
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          tenant_id: string
          trigger_event_id: string
          version_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "automation_runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_enrichment_jobs: {
        Args: { p_limit?: number; p_worker: string }
        Returns: {
          actual_cost: number
          actual_external_calls: number
          attempts: number
          completed_at: string | null
          created_at: string
          data_provider_id: string
          enrichment_type: string
          estimated_cost: number
          estimated_external_calls: number
          id: string
          idempotency_key: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          master_entity_id: string | null
          max_attempts: number
          next_attempt_at: string
          permission_id: string
          permission_result: Json
          provider_account_id: string | null
          purpose: string
          quota_result: Json
          requested_by: string | null
          requested_fields: string[]
          result_summary: Json
          started_at: string | null
          status: Database["public"]["Enums"]["enrichment_state"]
          tenant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "enrichment_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_ingestion_runs: {
        Args: { p_limit?: number; p_worker: string }
        Returns: {
          attempts: number
          changed_records: number
          completed_at: string | null
          created_at: string
          current_page: string | null
          error_records: number
          fetched_records: number
          id: string
          ingestion_job_id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          metadata: Json
          new_records: number
          next_attempt_at: string
          next_page: string | null
          parser_fingerprint: string | null
          parser_version_id: string | null
          quarantined_records: number
          quota_remaining: number | null
          requested_records: number
          started_at: string | null
          status: Database["public"]["Enums"]["ingestion_state"]
          tenant_id: string
          unchanged_records: number
        }[]
        SetofOptions: {
          from: "*"
          to: "ingestion_runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_nix_check_jobs: {
        Args: { p_limit?: number; p_worker: string }
        Returns: {
          attempts: number
          completed_at: string | null
          configuration_id: string
          created_at: string
          customer_id: string
          id: string
          idempotency_key: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          next_attempt_at: string
          phone_e164: string
          requested_by: string | null
          status: string
          tenant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "nix_check_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_outbox_jobs: {
        Args: { p_limit?: number; p_worker: string }
        Returns: {
          aggregate_id: string | null
          aggregate_type: string
          attempts: number
          available_at: string
          completed_at: string | null
          created_at: string
          id: string
          idempotency_key: string
          job_type: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          priority: number
          status: Database["public"]["Enums"]["job_status"]
          tenant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "outbox_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_segment_refresh_jobs: {
        Args: { p_limit?: number; p_worker: string }
        Returns: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          next_attempt_at: string
          reason: string
          segment_id: string
          status: string
          tenant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "segment_refresh_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_enrichment_job: {
        Args: {
          p_actual_cost?: number
          p_canonical: Json
          p_content_type?: string
          p_external_identifier: string
          p_facts: Json
          p_http_status?: number
          p_job_id: string
          p_metadata?: Json
          p_parser_version_id?: string
          p_payload_ciphertext?: string
          p_payload_sha256: string
          p_request_id?: string
          p_response_headers?: Json
          p_source_timestamp?: string
        }
        Returns: Json
      }
      complete_ingestion_record: {
        Args: {
          p_canonical: Json
          p_external_identifier: string
          p_facts: Json
          p_ingestion_run_id: string
          p_page_fingerprint?: string
          p_raw_payload_id: string
          p_source_timestamp?: string
        }
        Returns: Json
      }
      complete_ingestion_run: {
        Args: { p_metadata?: Json; p_next_page?: string; p_run_id: string }
        Returns: undefined
      }
      complete_nix_check_job: {
        Args: {
          p_evidence?: Json
          p_job_id: string
          p_result: string
          p_source_version?: string
        }
        Returns: undefined
      }
      complete_outbox_job: { Args: { p_job_id: string }; Returns: undefined }
      complete_segment_refresh_job: {
        Args: { p_error?: string; p_job_id: string }
        Returns: undefined
      }
      configure_generic_json_provider: {
        Args: {
          p_allowed_domains: string[]
          p_allowed_entity_types: Database["public"]["Enums"]["directory_entity_type"][]
          p_allowed_paths: string[]
          p_allowed_purposes: string[]
          p_attribution_required: boolean
          p_cache_scope: Database["public"]["Enums"]["provider_cache_scope"]
          p_credentials_ciphertext: string
          p_cross_tenant_reuse_allowed: boolean
          p_endpoint_template: string
          p_estimated_cost_per_call?: number
          p_export_allowed: boolean
          p_field_mapping: Json
          p_max_concurrency: number
          p_max_retries: number
          p_method: string
          p_minimum_delay_ms: number
          p_name: string
          p_permission_name: string
          p_provider: string
          p_quota_units: number
          p_quota_window_seconds: number
          p_raw_storage_allowed: boolean
          p_retention_days: number
          p_tenant_display_allowed: boolean
          p_timeout_ms: number
          p_ttl_days: number
          p_written_approval_reference: string
        }
        Returns: Json
      }
      consume_rate_limit: {
        Args: {
          p_bucket: string
          p_limit: number
          p_tenant_id: string
          p_window_seconds?: number
        }
        Returns: boolean
      }
      create_contract_draft: {
        Args: {
          p_commercial_terms: Json
          p_contract_number: string
          p_customer_id: string
          p_document_hash: string
          p_price_version_id: string
          p_product_id: string
          p_rendered_body: string
          p_rendered_terms: string
          p_sales_channel?: string
          p_title: string
        }
        Returns: string
      }
      create_contract_draft_v2: {
        Args: {
          p_commercial_terms: Json
          p_contract_number: string
          p_counterparty_snapshot: Json
          p_customer_id: string
          p_document_hash: string
          p_legal_entity_id: string
          p_price_version_id: string
          p_product_id: string
          p_rendered_body: string
          p_rendered_terms: string
          p_sales_channel: string
          p_seller_snapshot: Json
          p_template_id: string
          p_template_version_id: string
          p_title: string
        }
        Returns: string
      }
      create_contract_template_version: {
        Args: {
          p_audience: string
          p_body_template: string
          p_contract_type: string
          p_description: string
          p_legal_entity_id: string
          p_name: string
          p_signing_configuration?: Json
          p_template_id: string
          p_terms_template: string
          p_title_template: string
          p_variables?: Json
          p_variables_schema?: Json
        }
        Returns: string
      }
      create_tenant_with_owner: {
        Args: {
          p_legal_name: string
          p_name: string
          p_organization_number?: string
        }
        Returns: string
      }
      current_membership_role: {
        Args: never
        Returns: Database["public"]["Enums"]["membership_role"]
      }
      current_tenant_id: { Args: never; Returns: string }
      customer_has_legal_retention: {
        Args: { p_customer_id: string; p_tenant_id: string }
        Returns: boolean
      }
      dashboard_overview: { Args: never; Returns: Json }
      customer_list_overview: {
        Args: { p_list_id?: string | null }
        Returns: {
          list_id: string
          total_members: number
          open_members: number
          active_sellers: number
        }[]
      }
      customer_list_candidate_counts: {
        Args: { p_list_id: string }
        Returns: Json
      }
      control_ingestion_run: {
        Args: { p_run_id: string; p_action: string }
        Returns: Json
      }
      reserve_provider_ingestion_usage: {
        Args: { p_run_id: string; p_units?: number }
        Returns: Json
      }
      data_subject_export_for_request: {
        Args: { p_request_id: string }
        Returns: Json
      }
      directory_entity_for_tenant: {
        Args: { p_entity_id: string; p_tenant_id: string }
        Returns: {
          address_line1: string | null
          cache_scope: Database["public"]["Enums"]["provider_cache_scope"]
          canonical_name: string
          city: string | null
          country_code: string
          county: string | null
          county_code: string | null
          created_at: string
          current_master: Json
          data_provider_id: string
          data_quality_score: number
          date_of_birth: string | null
          email: string | null
          employee_count: number | null
          employer_registered: boolean | null
          enriched_at: string | null
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          external_primary_id: string | null
          f_tax_registered: boolean | null
          fresh_until: string | null
          id: string
          industry: string | null
          latitude: number | null
          legal_form: string | null
          license_tenant_id: string
          longitude: number | null
          merged_at: string | null
          merged_into_id: string | null
          municipality: string | null
          municipality_code: string | null
          next_refresh_at: string | null
          organization_number: string | null
          organization_status: string | null
          owner_tenant_id: string | null
          permission_id: string
          phone_e164: string | null
          phone_type: string | null
          postal_code: string | null
          provider_account_id: string | null
          registration_date: string | null
          result: number | null
          revenue: number | null
          sni_code: string | null
          source_removed_at: string | null
          updated_at: string
          vat_registered: boolean | null
          website: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "master_entities"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      directory_entity_projection_for_tenant: {
        Args: { p_entity_id: string; p_tenant_id: string }
        Returns: Json
      }
      directory_search_for_tenant: {
        Args: {
          p_city?: string
          p_country_code?: string
          p_county?: string
          p_employee_max?: number
          p_employee_min?: number
          p_entity_type?: Database["public"]["Enums"]["directory_entity_type"]
          p_fresh_only?: boolean
          p_has_email?: boolean
          p_has_phone?: boolean
          p_limit?: number
          p_municipality?: string
          p_offset?: number
          p_query?: string
          p_sni_code?: string
          p_tenant_id: string
        }
        Returns: {
          address_line1: string
          canonical_name: string
          city: string
          country_code: string
          county: string
          data_quality_score: number
          email: string
          employee_count: number
          enriched_at: string
          entity_type: Database["public"]["Enums"]["directory_entity_type"]
          fresh_until: string
          freshness_state: Database["public"]["Enums"]["directory_freshness_state"]
          id: string
          industry: string
          latitude: number
          legal_form: string
          longitude: number
          municipality: string
          organization_number: string
          organization_status: string
          phone_e164: string
          postal_code: string
          result: number
          revenue: number
          sni_code: string
          source_attribution_required: boolean
          website: string
        }[]
      }
      directory_search_summary_for_tenant: {
        Args: { p_filters?: Json; p_tenant_id: string }
        Returns: Json
      }
      directory_search_v2_for_tenant: {
        Args: {
          p_filters?: Json
          p_limit?: number
          p_offset?: number
          p_tenant_id: string
        }
        Returns: Json
      }
      directory_source_attribution_for_tenant: {
        Args: { p_entity_id: string; p_tenant_id: string }
        Returns: {
          attribution_required: boolean
          confidence: number
          last_seen_at: string
          manually_verified: boolean
          match_method: string
          removed_at: string
          source_name: string
        }[]
      }
      directory_visible_fields_for_tenant: {
        Args: { p_entity_id: string; p_tenant_id: string }
        Returns: {
          confidence: number
          field_key: string
          field_value: Json
          fresh_until: string
          selected_source_fact_id: string
          updated_at: string
          verified_at: string
        }[]
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      enqueue_automation_event: {
        Args: {
          p_entity_id: string
          p_entity_type: string
          p_event_id: string
          p_event_key: string
          p_input?: Json
          p_tenant_id: string
        }
        Returns: number
      }
      enqueue_outgoing_webhook_event: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_payload?: Json
          p_tenant_id: string
        }
        Returns: number
      }
      ensure_tenant_defaults: {
        Args: { p_tenant_id: string }
        Returns: undefined
      }
      ensure_tenant_import_provider: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      evaluate_contact_policy_for_tenant: {
        Args: {
          p_channel: string
          p_customer_id: string
          p_purpose?: string
          p_tenant_id: string
        }
        Returns: Json
      }
      execute_data_subject_erasure: {
        Args: { p_actor?: string; p_request_id: string }
        Returns: Json
      }
      fail_enrichment_job: {
        Args: {
          p_delay_seconds?: number
          p_details?: Json
          p_error: string
          p_job_id: string
          p_retryable?: boolean
          p_stage: string
        }
        Returns: undefined
      }
      fail_ingestion_run: {
        Args: {
          p_delay_seconds?: number
          p_details?: Json
          p_error: string
          p_raw_payload_id?: string
          p_retryable?: boolean
          p_run_id: string
        }
        Returns: undefined
      }
      fail_nix_check_job: {
        Args: { p_error: string; p_job_id: string; p_retryable?: boolean }
        Returns: undefined
      }
      fail_outbox_job: {
        Args: { p_delay_seconds?: number; p_error: string; p_job_id: string }
        Returns: undefined
      }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      gettransactionid: { Args: never; Returns: unknown }
      has_current_role: { Args: { p_roles: string[] }; Returns: boolean }
      haversine_km: {
        Args: { p_lat1: number; p_lat2: number; p_lon1: number; p_lon2: number }
        Returns: number
      }
      increment_usage: {
        Args: { p_amount?: number; p_metric: string; p_tenant_id: string }
        Returns: undefined
      }
      is_platform_role: {
        Args: { p_roles?: Database["public"]["Enums"]["platform_role"][] }
        Returns: boolean
      }
      is_provider_ip_allowed: {
        Args: { p_ip: unknown; p_provider: string }
        Returns: boolean
      }
      is_tenant_admin: { Args: { p_tenant_id?: string }; Returns: boolean }
      is_tenant_member: { Args: { p_tenant_id: string }; Returns: boolean }
      longtransactionsenabled: { Args: never; Returns: boolean }
      materialize_segment_to_campaign: {
        Args: { p_actor?: string; p_campaign_id: string; p_segment_id: string }
        Returns: Json
      }
      materialize_segment_to_customer_list: {
        Args: { p_list_id: string; p_segment_id: string }
        Returns: Json
      }
      merge_master_entities: {
        Args: {
          p_actor: string
          p_source: string
          p_target: string
          p_tenant_id: string
        }
        Returns: string
      }
      normalize_due_geographies: { Args: { p_limit?: number }; Returns: number }
      normalize_geo_token: { Args: { p_value: string }; Returns: string }
      normalize_identity_value: {
        Args: { p_type: string; p_value: string }
        Returns: string
      }
      normalize_master_entity_geography: {
        Args: { p_entity_id: string }
        Returns: Json
      }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      prepare_contract_delivery: {
        Args: {
          p_acceptance_code: string
          p_call_ended_at: string
          p_call_id: string
          p_channel: string
          p_contract_id: string
          p_email: string
          p_email_body: string
          p_email_from: string
          p_email_subject: string
          p_expires_at: string
          p_phone_e164: string
          p_public_token_hash: string
          p_recipient_name: string
          p_sms_body: string
          p_sms_from: string
        }
        Returns: string
      }
      apply_import_row_normalization: { Args: { p_import_run_id: string; p_rows: Json }; Returns: number }
      claim_parsehub_runs: { Args: { p_limit?: number; p_worker: string }; Returns: Database["public"]["Tables"]["parsehub_runs"]["Row"][] }
      process_import_run: { Args: { p_import_run_id: string }; Returns: Json }
      process_parsehub_import_run: { Args: { p_parsehub_run_id: string }; Returns: Json }
      save_import_profile: { Args: { p_automatic_commit: boolean; p_config: Json; p_field_mapping: Json; p_format: string; p_header_row: number; p_name: string; p_profile_id: string | null; p_records_path: string | null; p_source_provider: string; p_source_website: string | null; p_target_list_id: string | null; p_target_type: string; p_worksheet_name: string | null }; Returns: string }
      queue_due_nix_checks: { Args: { p_limit?: number }; Returns: number }
      queue_due_segment_refreshes: {
        Args: { p_limit?: number }
        Returns: number
      }
      queue_email_message: {
        Args: {
          p_body: string
          p_customer_id: string
          p_idempotency_key: string
          p_purpose?: string
          p_subject: string
        }
        Returns: string
      }
      queue_email_message_for_tenant: {
        Args: {
          p_body: string
          p_contract_id?: string
          p_created_by?: string
          p_customer_id: string
          p_idempotency_key: string
          p_payload?: Json
          p_purpose?: string
          p_subject: string
          p_tenant_id: string
          p_to_address?: string
        }
        Returns: string
      }
      queue_nix_check_for_customer: {
        Args: {
          p_customer_id: string
          p_force?: boolean
          p_requested_by?: string
          p_tenant_id: string
        }
        Returns: string
      }
      add_customers_to_list: {
        Args: { p_customer_ids: string[]; p_list_id: string }
        Returns: number
      }
      can_manage_customer_list: {
        Args: { p_list_id: string }
        Returns: boolean
      }
      can_work_customer_list: {
        Args: { p_list_id: string }
        Returns: boolean
      }
      claim_next_list_member: {
        Args: { p_list_id: string; p_session_id: string }
        Returns: Json
      }
      claim_next_list_member_with_contacts: { Args: { p_list_id: string; p_session_id: string }; Returns: Json }
      claim_customer_callback: {
        Args: { p_activity_id: string }
        Returns: Json
      }
      complete_customer_callback: {
        Args: { p_activity_id: string; p_notes?: string | null }
        Returns: undefined
      }
      complete_dialer_work: {
        Args: {
          p_call_id: string
          p_callback_due_at: string | null
          p_callback_scope: string | null
          p_create_order: boolean
          p_disposition_key: string
          p_idempotency_key: string
          p_notes: string | null
          p_product_id: string | null
          p_quantity: number | null
          p_unit_price: number | null
        }
        Returns: Json
      }
      complete_manual_call_work: {
        Args: {
          p_call_id: string
          p_callback_due_at: string | null
          p_callback_scope: string | null
          p_disposition: string
          p_notes: string | null
        }
        Returns: Json
      }
      create_managed_customer_list: {
        Args: {
          p_allow_browse: boolean
          p_allow_skip: boolean
          p_allowed_days: number[]
          p_auto_next_delay_seconds: number
          p_callback_policy: string
          p_description: string
          p_dialing_mode: string
          p_end_time: string
          p_list_type: string
          p_max_attempts: number
          p_name: string
          p_priority: number
          p_retry_delay_minutes: number
          p_script: string
          p_start_time: string
          p_team_id: string | null
        }
        Returns: string
      }
      create_or_match_manual_prospect: {
        Args: {
          p_customer_type?: Database["public"]["Enums"]["customer_type"]
          p_display_name: string
          p_phone_e164: string
        }
        Returns: Json
      }
      queue_outbound_call: {
        Args: {
          p_callback_token: string
          p_callback_token_hash: string
          p_customer_id: string
          p_idempotency_key: string
          p_purpose?: string
          p_voice_client_number: string
        }
        Returns: string
      }
      queue_outbound_call_target: { Args: { p_callback_token: string; p_callback_token_hash: string; p_contact_person_id: string | null; p_customer_id: string; p_idempotency_key: string; p_purpose?: string; p_target_phone: string; p_voice_client_number: string }; Returns: string }
      queue_list_outbound_call: {
        Args: {
          p_callback_activity_id: string | null
          p_callback_token: string
          p_callback_token_hash: string
          p_idempotency_key: string
          p_list_member_id: string
          p_purpose?: string
          p_session_id: string
          p_voice_client_number: string
        }
        Returns: string
      }
      queue_list_outbound_call_target: { Args: { p_callback_activity_id: string | null; p_callback_token: string; p_callback_token_hash: string; p_contact_person_id: string | null; p_idempotency_key: string; p_list_member_id: string; p_purpose?: string; p_session_id: string; p_target_phone: string; p_voice_client_number: string }; Returns: string }
      queue_callback_outbound_call: {
        Args: {
          p_activity_id: string
          p_callback_token: string
          p_callback_token_hash: string
          p_customer_id: string
          p_idempotency_key: string
          p_purpose?: string
          p_voice_client_number: string
        }
        Returns: string
      }
      reassign_customer_callback: {
        Args: { p_activity_id: string; p_user_id: string }
        Returns: undefined
      }
      release_list_member_claim: {
        Args: { p_reason?: string; p_session_id: string }
        Returns: undefined
      }
      schedule_customer_callback: {
        Args: {
          p_customer_id: string
          p_description: string
          p_due_at: string
          p_list_id: string | null
          p_scope: string
          p_title: string
        }
        Returns: string
      }
      snooze_customer_callback: {
        Args: { p_activity_id: string; p_snoozed_until: string }
        Returns: undefined
      }
      set_customer_list_sellers: {
        Args: { p_list_id: string; p_user_ids: string[] }
        Returns: number
      }
      start_dialer_session: {
        Args: { p_list_id: string }
        Returns: string
      }
      update_customer_list_configuration: {
        Args: {
          p_allow_browse: boolean
          p_allow_skip: boolean
          p_auto_next_delay_seconds: number
          p_callback_policy: string
          p_description: string
          p_dialing_mode: string
          p_end_time: string
          p_list_id: string
          p_lock_to_seller: boolean
          p_max_attempts: number
          p_name: string
          p_outbound_phone_number_id: string | null
          p_priority: number
          p_recording_enabled: boolean
          p_retry_delay_minutes: number
          p_script: string
          p_start_time: string
          p_starts_at: string | null
          p_status: string
          p_ends_at: string | null
          p_timezone: string
        }
        Returns: undefined
      }
      queue_sms_message: {
        Args: {
          p_body: string
          p_customer_id: string
          p_idempotency_key: string
          p_purpose?: string
        }
        Returns: string
      }
      queue_sms_message_for_tenant: {
        Args: {
          p_body: string
          p_contract_id?: string
          p_created_by?: string
          p_customer_id: string
          p_idempotency_key: string
          p_payload?: Json
          p_purpose?: string
          p_tenant_id: string
          p_to_number?: string
        }
        Returns: string
      }
      rebuild_master_entity: {
        Args: { p_entity_id: string }
        Returns: undefined
      }
      recalculate_data_quality: {
        Args: { p_entity_id: string }
        Returns: number
      }
      record_contract_acceptance: {
        Args: {
          p_acceptance_code?: string
          p_acceptance_phrase?: string
          p_evidence?: Json
          p_ip_address?: unknown
          p_method: Database["public"]["Enums"]["acceptance_method"]
          p_normalized_response?: string
          p_provider_message_id?: string
          p_raw_response?: string
          p_request_id: string
          p_status: Database["public"]["Enums"]["acceptance_status"]
          p_user_agent?: string
        }
        Returns: string
      }
      record_ingestion_raw_payload: {
        Args: {
          p_content_type: string
          p_external_identifier: string
          p_http_status: number
          p_ingestion_run_id: string
          p_metadata?: Json
          p_payload_ciphertext: string
          p_payload_sha256: string
          p_request_id: string
          p_response_headers: Json
          p_source_timestamp: string
          p_storage_path: string
        }
        Returns: string
      }
      refresh_segment_materialization: {
        Args: { p_actor?: string; p_segment_id: string }
        Returns: Json
      }
      refresh_due_dynamic_customer_lists: {
        Args: { p_limit?: number }
        Returns: Json
      }
      reserve_usage_for_tenant: {
        Args: { p_amount?: number; p_metric: string; p_tenant_id: string }
        Returns: undefined
      }
      rollback_import_run: {
        Args: { p_import_run_id: string }
        Returns: number
      }
      run_retention_maintenance: {
        Args: { p_limit?: number; p_tenant_id: string }
        Returns: Json
      }
      safe_uuid: { Args: { p_value: string }; Returns: string }
      schedule_due_ingestion_jobs: {
        Args: { p_limit?: number }
        Returns: {
          attempts: number
          changed_records: number
          completed_at: string | null
          created_at: string
          current_page: string | null
          error_records: number
          fetched_records: number
          id: string
          ingestion_job_id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          metadata: Json
          new_records: number
          next_attempt_at: string
          next_page: string | null
          parser_fingerprint: string | null
          parser_version_id: string | null
          quarantined_records: number
          quota_remaining: number | null
          requested_records: number
          started_at: string | null
          status: Database["public"]["Enums"]["ingestion_state"]
          tenant_id: string
          unchanged_records: number
        }[]
        SetofOptions: {
          from: "*"
          to: "ingestion_runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      set_platform_membership: {
        Args: {
          p_reason?: string
          p_role: Database["public"]["Enums"]["platform_role"]
          p_status?: string
          p_user_id: string
        }
        Returns: undefined
      }
      set_tenant_feature: {
        Args: {
          p_configuration?: Json
          p_enabled: boolean
          p_feature_key: string
        }
        Returns: undefined
      }
      set_tenant_platform_status: {
        Args: { p_reason: string; p_status: string; p_tenant_id: string }
        Returns: undefined
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      source_priority_for: {
        Args: { p_field: string; p_source_class: string; p_tenant: string }
        Returns: number
      }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      sync_tenant_import_to_directory: {
        Args: {
          p_customer_id: string
          p_data: Json
          p_import_row_id: number
          p_import_run_id: string
          p_tenant_id: string
        }
        Returns: string
      }
      undo_master_entity_merge: {
        Args: { p_actor: string; p_decision_id: string }
        Returns: undefined
      }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
      upsert_geographic_reference_batch: {
        Args: { p_rows: Json; p_source: string; p_source_version?: string }
        Returns: number
      }
      upsert_tenant_legal_entity: {
        Args: {
          p_address_line1: string
          p_city: string
          p_country_code: string
          p_email: string
          p_id: string
          p_is_default: boolean
          p_legal_name: string
          p_organization_number: string
          p_phone_e164: string
          p_postal_code: string
          p_website: string
        }
        Returns: string
      }
    }
    Enums: {
      acceptance_method:
        | "sms"
        | "web"
        | "email_otp"
        | "sms_otp"
        | "bankid"
        | "electronic_signature"
        | "manual"
      acceptance_status:
        | "pending"
        | "accepted_via_sms"
        | "accepted_via_web"
        | "signed_with_bankid"
        | "signed_electronically"
        | "declined"
        | "expired"
        | "cancelled"
        | "superseded"
        | "manual_review_required"
      activity_status: "open" | "in_progress" | "completed" | "cancelled"
      activity_type:
        | "task"
        | "call"
        | "callback"
        | "meeting"
        | "email"
        | "sms"
        | "note"
        | "contract_followup"
        | "renewal"
        | "onboarding"
      automation_status: "draft" | "active" | "paused" | "archived"
      communication_direction: "inbound" | "outbound"
      contract_status:
        | "draft"
        | "ready"
        | "sent"
        | "delivered"
        | "opened"
        | "signing"
        | "accepted"
        | "signed"
        | "declined"
        | "expired"
        | "cancelled"
        | "superseded"
        | "active"
        | "terminated"
      customer_lifecycle:
        | "prospect"
        | "lead"
        | "customer"
        | "former_customer"
        | "lost"
        | "blocked"
      customer_type: "person" | "company"
      deal_status: "open" | "won" | "lost" | "archived"
      delivery_status:
        | "draft"
        | "queued"
        | "submitting"
        | "created"
        | "sent"
        | "delivered"
        | "opened"
        | "failed"
        | "cancelled"
      directory_entity_type: "organization" | "establishment" | "person"
      directory_freshness_state:
        | "fresh"
        | "stale"
        | "missing"
        | "refreshing"
        | "quarantined"
      enrichment_state:
        | "queued"
        | "running"
        | "completed"
        | "partially_completed"
        | "failed"
        | "cancelled"
      import_status:
        | "uploaded"
        | "parsing"
        | "mapping_required"
        | "validating"
        | "preview_ready"
        | "validated"
        | "queued"
        | "processing"
        | "completed"
        | "completed_with_warnings"
        | "failed"
        | "rolled_back"
        | "cancelled"
      ingestion_state:
        | "scheduled"
        | "running"
        | "paused"
        | "quarantined"
        | "completed"
        | "failed"
        | "cancelled"
      job_status:
        | "pending"
        | "processing"
        | "completed"
        | "failed"
        | "dead_letter"
        | "cancelled"
      membership_role:
        | "owner"
        | "admin"
        | "team_lead"
        | "sales"
        | "contract_manager"
        | "quality"
        | "backoffice"
        | "finance"
        | "viewer"
      membership_status: "invited" | "active" | "suspended" | "removed"
      platform_role:
        | "platform_owner"
        | "platform_admin"
        | "platform_support"
        | "platform_auditor"
      provider_cache_scope:
        | "global"
        | "provider_account"
        | "tenant"
        | "one_time"
    }
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      acceptance_method: [
        "sms",
        "web",
        "email_otp",
        "sms_otp",
        "bankid",
        "electronic_signature",
        "manual",
      ],
      acceptance_status: [
        "pending",
        "accepted_via_sms",
        "accepted_via_web",
        "signed_with_bankid",
        "signed_electronically",
        "declined",
        "expired",
        "cancelled",
        "superseded",
        "manual_review_required",
      ],
      activity_status: ["open", "in_progress", "completed", "cancelled"],
      activity_type: [
        "task",
        "call",
        "callback",
        "meeting",
        "email",
        "sms",
        "note",
        "contract_followup",
        "renewal",
        "onboarding",
      ],
      automation_status: ["draft", "active", "paused", "archived"],
      communication_direction: ["inbound", "outbound"],
      contract_status: [
        "draft",
        "ready",
        "sent",
        "delivered",
        "opened",
        "signing",
        "accepted",
        "signed",
        "declined",
        "expired",
        "cancelled",
        "superseded",
        "active",
        "terminated",
      ],
      customer_lifecycle: [
        "prospect",
        "lead",
        "customer",
        "former_customer",
        "lost",
        "blocked",
      ],
      customer_type: ["person", "company"],
      deal_status: ["open", "won", "lost", "archived"],
      delivery_status: [
        "draft",
        "queued",
        "submitting",
        "created",
        "sent",
        "delivered",
        "opened",
        "failed",
        "cancelled",
      ],
      directory_entity_type: ["organization", "establishment", "person"],
      directory_freshness_state: [
        "fresh",
        "stale",
        "missing",
        "refreshing",
        "quarantined",
      ],
      enrichment_state: [
        "queued",
        "running",
        "completed",
        "partially_completed",
        "failed",
        "cancelled",
      ],
      import_status: [
        "uploaded",
        "parsing",
        "mapping_required",
        "validating",
        "preview_ready",
        "validated",
        "queued",
        "processing",
        "completed",
        "completed_with_warnings",
        "failed",
        "rolled_back",
        "cancelled",
      ],
      ingestion_state: [
        "scheduled",
        "running",
        "paused",
        "quarantined",
        "completed",
        "failed",
        "cancelled",
      ],
      job_status: [
        "pending",
        "processing",
        "completed",
        "failed",
        "dead_letter",
        "cancelled",
      ],
      membership_role: [
        "owner",
        "admin",
        "team_lead",
        "sales",
        "contract_manager",
        "quality",
        "backoffice",
        "finance",
        "viewer",
      ],
      membership_status: ["invited", "active", "suspended", "removed"],
      platform_role: [
        "platform_owner",
        "platform_admin",
        "platform_support",
        "platform_auditor",
      ],
      provider_cache_scope: [
        "global",
        "provider_account",
        "tenant",
        "one_time",
      ],
    },
  },
} as const
