-- Thirteen superseded RPCs were still executable by `authenticated`.
--
-- Each has a successor the application actually calls, and none of them appears
-- in any `.rpc(...)` call site in the repository — the only textual matches are
-- substrings of the successor's own name, or a comment. What remained was the
-- grant, and Supabase publishes a granted function as `/rest/v1/rpc/<name>`. So
-- the older generation of each stayed callable by anyone holding a session,
-- indefinitely, with no code path exercising it and therefore nothing keeping
-- its behaviour true.
--
-- This is hardening, not a fix for a known exploit, and it is written as such.
-- One concrete divergence was confirmed while checking: `update_tenant_member`
-- predates v3's `removed_member_requires_reactivation_workflow` guard, so the
-- old entry point can reactivate a removed member without that workflow. One
-- suspicion was checked and turned out false — `complete_dialer_work` does carry
-- the terminal-status guard its v2 wrapper also applies, so that pair diverges
-- only in the wrapper. The rest were not individually audited, which is the
-- argument rather than a gap in it: unused public surface is surface nobody is
-- keeping correct.
--
-- Safe to revoke. Every internal caller is itself SECURITY DEFINER, so those
-- chains execute as the definer and a grant on `authenticated` is irrelevant to
-- them:
--
--   claim_next_list_member      <- claim_next_list_member_with_contacts
--   complete_dialer_work        <- complete_dialer_work_v2
--   complete_manual_call_work   <- complete_manual_call_work_v2
--   create_contract_draft       <- create_contract_draft_v2
--   create_contract_draft_v2    <- create_contract_draft_v3, create_contract_draft_api_v2
--   create_managed_team         <- create_managed_team_v2
--   reserve_tenant_invitation   <- register_tenant_invitation, reserve_tenant_invitation_v2
--
-- The other six have no internal caller at all.
--
-- The functions stay. Dropping them would break those definer chains and rewrite
-- delivered migrations; only the public entry point closes.
--
-- An earlier hardening pass over-revoked and took `undo_master_entity_merge`
-- with it, which the admin UI needed. The guard against repeating that is not in
-- this file: PGlite replays migrations as superuser and does not enforce GRANT,
-- so no runtime test here can see it. It is the production check that every name
-- appearing in a `.rpc(...)` call site is still executable by `authenticated` or
-- `service_role` — run against this migration before it was committed.

revoke all on function public.assign_platform_rinkel_number_to_teams(uuid, uuid[], text) from authenticated;
revoke all on function public.claim_next_list_member(uuid, uuid) from authenticated;
revoke all on function public.complete_dialer_work(uuid, text, text, text, timestamptz, boolean, uuid, numeric, numeric, text) from authenticated;
revoke all on function public.complete_manual_call_work(uuid, text, text, text, timestamptz) from authenticated;
revoke all on function public.create_contract_draft(text, uuid, uuid, uuid, text, text, text, jsonb, text, text) from authenticated;
revoke all on function public.create_contract_draft_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, text, text, jsonb, jsonb) from authenticated;
revoke all on function public.create_managed_team(text, text, text, text, text, boolean, integer, text) from authenticated;
revoke all on function public.queue_callback_outbound_call(uuid, uuid, text, text, text, text, text) from authenticated;
revoke all on function public.register_tenant_invitation(uuid, uuid, text, public.membership_role, uuid[], text, timestamptz) from authenticated;
revoke all on function public.replace_rinkel_user_mapping_v2(uuid, uuid, uuid) from authenticated;
revoke all on function public.reserve_tenant_invitation(uuid, text, public.membership_role, uuid[], text, timestamptz, text) from authenticated;
revoke all on function public.update_tenant_member(uuid, public.membership_role, public.membership_status, uuid) from authenticated;
revoke all on function public.update_tenant_member_v2(uuid, public.membership_role, public.membership_status, uuid, uuid[], boolean) from authenticated;
