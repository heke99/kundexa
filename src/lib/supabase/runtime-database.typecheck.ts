import type { RuntimeDatabase } from "@/lib/supabase/runtime-database.types";

type Assert<T extends true> = T;
type SaveImportProfileArgs = RuntimeDatabase["public"]["Functions"]["save_import_profile"]["Args"];
type CreateTemplateVersionArgs = RuntimeDatabase["public"]["Functions"]["create_contract_template_version"]["Args"];

/** Compile-time regressions for PostgreSQL RPC arguments that intentionally accept SQL NULL. */
type RpcNullableProfileId = Assert<null extends SaveImportProfileArgs["p_profile_id"] ? true : false>;
type RpcNullableTemplateId = Assert<null extends CreateTemplateVersionArgs["p_template_id"] ? true : false>;
type RpcPreservesString = Assert<string extends Exclude<CreateTemplateVersionArgs["p_template_id"], null> ? true : false>;

export type RuntimeDatabaseTypeContract =
  | RpcNullableProfileId
  | RpcNullableTemplateId
  | RpcPreservesString;
