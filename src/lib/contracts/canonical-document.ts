import type { SupabaseClient } from "@supabase/supabase-js";
import { createCanonicalContractSnapshot } from "@/lib/contracts/canonical-contract-snapshot";
import { generateContractPdf } from "@/lib/contracts/generate-contract-pdf";
import { hashPdfBytes } from "@/lib/contracts/document-hash";

export type CanonicalDocumentResult = {
  id: string;
  sha256: string;
  file_name: string;
  storage_path: string;
  size_bytes: number;
  snapshot_hash: string;
};

export async function ensureCanonicalContractDocument(
  supabase: SupabaseClient,
  input: { tenantId: string; contractId: string; actorUserId: string },
): Promise<CanonicalDocumentResult> {
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id,tenant_id,contract_number,title,audience,sales_channel,starts_on,ends_on,binding_months,notice_months,value,currency,created_at,seller_snapshot,counterparty_snapshot,active_version_id,source_call_id,status")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.contractId)
    .single();
  if (contractError || !contract?.active_version_id) throw new Error(contractError?.message ?? "contract_or_active_version_missing");
  if (!contract.source_call_id) throw new Error("source_call_required_before_canonical_pdf");

  const { data: existing } = await supabase
    .from("contract_documents")
    .select("id,sha256,file_name,storage_path,size_bytes,metadata")
    .eq("tenant_id", input.tenantId)
    .eq("contract_id", input.contractId)
    .eq("contract_version_id", contract.active_version_id)
    .in("document_type", ["generated_pdf", "source_pdf"])
    .contains("metadata", { canonical: true })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      id: existing.id,
      sha256: existing.sha256,
      file_name: existing.file_name,
      storage_path: existing.storage_path,
      size_bytes: Number(existing.size_bytes ?? 0),
      snapshot_hash: String((existing.metadata as Record<string, unknown> | null)?.snapshot_hash ?? ""),
    };
  }

  const [{ data: version, error: versionError }, { data: call, error: callError }] = await Promise.all([
    supabase.from("contract_versions")
      .select("id,version,title,rendered_body,rendered_terms,commercial_terms,template_version_id,price_version_id,locked_at,created_at")
      .eq("tenant_id", input.tenantId).eq("id", contract.active_version_id).single(),
    supabase.from("calls")
      .select("id,ended_at,disposition,user_id")
      .eq("tenant_id", input.tenantId).eq("id", contract.source_call_id).single(),
  ]);
  if (versionError || !version) throw new Error(versionError?.message ?? "contract_version_missing");
  if (version.locked_at) throw new Error("contract_version_already_locked_without_canonical_document");
  if (callError || !call?.ended_at || !call.disposition) throw new Error(callError?.message ?? "source_call_incomplete");

  const { snapshot, snapshotHash } = createCanonicalContractSnapshot(
    {
      ...contract,
      value: Number(contract.value ?? 0),
      seller_snapshot: (contract.seller_snapshot ?? {}) as Record<string, unknown>,
      counterparty_snapshot: (contract.counterparty_snapshot ?? {}) as Record<string, unknown>,
    },
    {
      ...version,
      commercial_terms: (version.commercial_terms ?? {}) as Record<string, unknown>,
    },
    { id: call.id, ended_at: call.ended_at, disposition: call.disposition, user_id: call.user_id },
  );
  const bytes = await generateContractPdf(snapshot, snapshotHash);
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("generated_contract_pdf_exceeds_20_mb");
  const fileName = `${contract.contract_number}.pdf`.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${input.tenantId}/${input.contractId}/${version.id}/${fileName}`;
  const { error: uploadError } = await supabase.storage.from("contract-documents").upload(storagePath, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  const alreadyExists = Boolean(uploadError?.message.toLowerCase().includes("already exists"));
  if (uploadError && !alreadyExists) throw new Error(uploadError.message);

  let canonicalBytes = bytes;
  if (alreadyExists) {
    const { data: stored, error: downloadError } = await supabase.storage.from("contract-documents").download(storagePath);
    if (downloadError || !stored) throw new Error(downloadError?.message ?? "canonical_document_race_download_failed");
    canonicalBytes = new Uint8Array(await stored.arrayBuffer());
    if (canonicalBytes.byteLength > 20 * 1024 * 1024) throw new Error("stored_contract_pdf_exceeds_20_mb");
  }
  const pdfHash = hashPdfBytes(canonicalBytes);

  const { data: document, error: documentError } = await supabase.from("contract_documents").upsert({
    tenant_id: input.tenantId,
    contract_id: input.contractId,
    contract_version_id: version.id,
    document_type: "generated_pdf",
    file_name: fileName,
    storage_path: storagePath,
    mime_type: "application/pdf",
    size_bytes: canonicalBytes.byteLength,
    sha256: pdfHash,
    metadata: { canonical: true, snapshot_hash: snapshotHash, schema_version: snapshot.schema_version, generated_at: snapshot.generated_at },
  }, { onConflict: "tenant_id,storage_path" }).select("id,sha256,file_name,storage_path,size_bytes").single();
  if (documentError || !document) {
    if (!uploadError) await supabase.storage.from("contract-documents").remove([storagePath]);
    throw new Error(documentError?.message ?? "canonical_document_insert_failed");
  }

  const { error: versionUpdateError } = await supabase.from("contract_versions")
    .update({ snapshot_hash: snapshotHash })
    .eq("tenant_id", input.tenantId).eq("id", version.id).is("locked_at", null);
  if (versionUpdateError) throw new Error(versionUpdateError.message);
  await supabase.from("contract_events").insert({
    tenant_id: input.tenantId,
    contract_id: input.contractId,
    event_type: "document.canonical_generated",
    actor_user_id: input.actorUserId,
    payload: { document_id: document.id, snapshot_hash: snapshotHash, pdf_sha256: pdfHash, size_bytes: canonicalBytes.byteLength },
  });

  return { ...document, size_bytes: Number(document.size_bytes ?? canonicalBytes.byteLength), snapshot_hash: snapshotHash };
}
