import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";

export function documentsConfiguration() {
  const url = process.env.KUNDEXA_DOCUMENTS_URL?.replace(/\/$/, "");
  const apiKey = process.env.KUNDEXA_DOCUMENTS_API_KEY;
  const secret = process.env.KUNDEXA_DOCUMENTS_SECRET;
  if (!url || !apiKey || !secret || secret.length < 32) throw new Error("documents_service_not_configured");
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
    || (parsed.protocol !== "https:" && process.env.NODE_ENV !== "development")) throw new Error("invalid_documents_service_url");
  return { url, apiKey, secret };
}

export async function probeDocumentsService() {
  try {
    await documentsRequest("/api/templates?limit=1");
    return true;
  } catch { return false; }
}

export async function documentsRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = documentsConfiguration();
  const response = await fetch(config.url + path, {
    ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(25_000),
    headers: { "X-Auth-Token": config.apiKey, ...init.headers },
  });
  if (!response.ok) {
    // No provider body/URL containing bearer links goes into seller-facing errors.
    console.error("documents_request_failed", { path: path.split("?")[0], status: response.status });
    throw new Error(`documents_http_${response.status}`);
  }
  return await response.json() as T;
}

export async function downloadEnginePdf(url: string) {
  const config = documentsConfiguration();
  if (new URL(url).origin !== new URL(config.url).origin) throw new Error("documents_download_origin_mismatch");
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`documents_download_http_${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > 20 * 1024 * 1024) throw new Error("document_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("document_body_missing");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error("document_too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("invalid_pdf_document");
  return bytes;
}

export const engineSnapshotSchema = z.object({
  id: z.number().int().positive(), external_id: z.string(), schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.object({
    fields: z.array(z.object({ uuid: z.uuid(), name: z.string().min(1), type: z.string(),
      submitter_uuid: z.uuid(), required: z.boolean().optional() }).passthrough()),
    submitters: z.array(z.object({ uuid: z.uuid(), name: z.string() }).passthrough()),
    documents: z.array(z.object({ uuid: z.uuid(), sha256: z.string(), filename: z.string() })),
    schema: z.array(z.record(z.string(), z.unknown())),
  }),
});
export type EngineSnapshot = z.infer<typeof engineSnapshotSchema>;

export async function readEngineTemplate(id: number, lock = false, expectedHash?: string): Promise<EngineSnapshot> {
  const result = await documentsRequest(`/kundexa/templates/${id}/snapshot`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lock, expected_schema_hash: expectedHash }),
  });
  return engineSnapshotSchema.parse(result);
}

export function engineBuilderUrl(templateId: number, externalId: string) {
  const config = documentsConfiguration();
  const payload = Buffer.from(JSON.stringify({ purpose: "builder", template_id: templateId,
    external_id: externalId, exp: Math.floor(Date.now() / 1000) + 30 * 60 })).toString("base64url");
  const signature = createHmac("sha256", config.secret).update(payload).digest("base64url");
  return `${config.url}/kundexa/templates/${templateId}/edit?token=${payload}.${signature}`;
}

export type EngineSigner = { id: number; submission_id: number; slug: string; email: string; status?: string;
  completed_at?: string | null; external_id?: string | null; embed_src?: string; role?: string };

export async function createEngineSubmission(input: {
  key: string; templateId: number; schemaHash: string; role: string;
  name: string; email: string; recipientId: string; values: Record<string, string>; expiresAt?: string; returnUrl?: string;
}) {
  const result = await documentsRequest<EngineSigner[]>("/kundexa/submissions", { method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": input.key },
    body: JSON.stringify({ template_id: input.templateId, schema_hash: input.schemaHash,
      send_email: false, send_sms: false, order: "preserved", ...(input.expiresAt ? { expire_at: input.expiresAt } : {}),
      submitters: [{ name: input.name, email: input.email, role: input.role, external_id: input.recipientId,
        ...(input.returnUrl ? { completed_redirect_url: input.returnUrl } : {}),
        send_email: false, values: input.values, readonly_fields: Object.keys(input.values) }] }),
  });
  if (!Array.isArray(result) || result.length !== 1 || !result[0].submission_id || !result[0].slug)
    throw new Error("invalid_documents_submission_response");
  return result[0];
}

export async function engineDocuments(id: number) {
  return documentsRequest<{ documents: Array<{ name: string; url: string }> }>(`/api/submissions/${id}/documents?merge=true`);
}

export async function engineSubmission(id: number) {
  return documentsRequest<{ id: number; status: string; completed_at: string | null; audit_log_url: string | null;
    submitters: EngineSigner[]; documents: Array<{ name: string; url: string }> }>(`/api/submissions/${id}`);
}
