import Link from "next/link";
import { CheckCircle2, Download, FileSignature, ShieldCheck } from "@/components/icons";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { sha256 } from "@/lib/crypto";
import { respondPublicContract } from "@/app/actions/public-contract";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/form-field";
import { Logo } from "@/components/logo";
import { formatCurrency, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AcceptPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string; accepted?: string; declined?: string }> }) {
  const { token } = await params;
  const query = await searchParams;
  const env = serverEnv();
  const admin = createAdminClient();
  const tokenHash = sha256(token + env.KUNDEXA_WEBHOOK_PEPPER);
  const { data: request } = await admin.from("contract_acceptance_requests")
    .select("id,tenant_id,status,expires_at,opened_at,canonical_document_id,canonical_document_sha256,contracts(id,contract_number,title,value,currency,audience,source_call_id,seller_snapshot,tenants(name,legal_name),customers(display_name)),contract_versions(id,version,rendered_body,rendered_terms,snapshot_hash,document_hash)")
    .eq("public_token_hash", tokenHash).single();
  if (!request) notFound();
  const contract = Array.isArray(request.contracts) ? request.contracts[0] : request.contracts;
  const version = Array.isArray(request.contract_versions) ? request.contract_versions[0] : request.contract_versions;
  const { data: document } = request.canonical_document_id
    ? await admin.from("contract_documents")
      .select("id,file_name,size_bytes,sha256")
      .eq("tenant_id", request.tenant_id)
      .eq("id", request.canonical_document_id)
      .maybeSingle()
    : { data: null };
  const tenantRaw = contract?.tenants as unknown as { name?: string; legal_name?: string } | { name?: string; legal_name?: string }[] | null;
  const tenant = Array.isArray(tenantRaw) ? tenantRaw[0] : tenantRaw;
  const customerRaw = contract?.customers as unknown as { display_name?: string } | { display_name?: string }[] | null;
  const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  const sellerSnapshot = (contract?.seller_snapshot ?? {}) as Record<string, unknown>;
  const branding = (sellerSnapshot.branding ?? {}) as Record<string, unknown>;
  const logoUrl = typeof branding.logo_url === "string" && /^https:\/\//i.test(branding.logo_url) ? branding.logo_url : null;
  const legalName = typeof sellerSnapshot.legal_name === "string" ? sellerSnapshot.legal_name : (tenant?.legal_name ?? tenant?.name ?? "Avsändaren");
  const expired = request.status === "pending" && new Date(request.expires_at) <= new Date();
  if (expired) {
    await admin.from("contract_acceptance_requests").update({ status: "expired" }).eq("id", request.id).eq("status", "pending");
    await admin.rpc("cancel_contract_reminders", { p_acceptance_request_id: request.id, p_reason: "expired" });
  }
  if (!request.opened_at && !expired && request.status === "pending") {
    const openedAt = new Date().toISOString();
    await Promise.all([
      admin.from("contract_acceptance_requests").update({ opened_at: openedAt }).eq("id", request.id).is("opened_at", null),
      contract?.id ? admin.from("contract_events").insert({ tenant_id: request.tenant_id, contract_id: contract.id, event_type: "acceptance.opened", payload: { request_id: request.id, opened_at: openedAt } }) : Promise.resolve(),
    ]);
  }

  const completed = query.accepted === "1" || request.status === "accepted_via_web";
  const declined = query.declined === "1" || request.status === "declined";
  if (completed || declined) return <main className="landing" style={{ display: "grid", placeItems: "center", padding: 24, minHeight: "100vh" }}><Card style={{ maxWidth: 620 }}><CardContent style={{ textAlign: "center", padding: 45 }}><CheckCircle2 size={48} color="#10866c" /><h1 style={{ marginTop: 18 }}>{completed ? "Avtalet är accepterat" : "Ditt besked är registrerat"}</h1><p className="muted">{completed ? "Din dokumenterade acceptans har tidsstämplats och bundits till exakt avtalsversion och PDF-hash. En bekräftelse köas enligt avsändarens inställningar." : "Du har avstått från avtalet. Inga framtida påminnelser skickas för denna acceptbegäran."}</p>{document ? <Link href={`/api/public/contracts/${token}/document`} className="button button-secondary"><Download size={16} /> Hämta avtalskopian</Link> : null}</CardContent></Card></main>;

  const inactive = expired || ["expired", "cancelled", "superseded"].includes(request.status);
  return <main className="landing" style={{ minHeight: "100vh", padding: 24 }}><div style={{ maxWidth: 820, margin: "0 auto" }}><div style={{ padding: "20px 0" }}>{logoUrl ? <img src={logoUrl} alt={legalName} style={{ display: "block", maxWidth: 210, maxHeight: 72, width: "auto", height: "auto" }} /> : <Logo />}</div><Card><CardHeader><div><span className="eyebrow">Säker avtalsgranskning</span><h1 style={{ margin: "14px 0 0" }}>{contract?.title}</h1></div><FileSignature size={28} /></CardHeader><CardContent>
    <div className="notice"><strong>Avtalspart:</strong> {legalName}<br /><strong>Kund:</strong> {customer?.display_name}<br /><strong>Avtalsnummer:</strong> {contract?.contract_number}<br /><strong>Version:</strong> {version?.version}<br /><strong>Värde:</strong> {formatCurrency(Number(contract?.value), contract?.currency)}<br /><strong>Giltig till:</strong> {formatDate(request.expires_at)}<br /><strong>Källsamtal:</strong> {contract?.source_call_id ? "Verifierat och bundet" : "Saknas"}</div>
    <section style={{ padding: "28px 4px", lineHeight: 1.8 }}><h2>Avtalsinnehåll</h2><p style={{ whiteSpace: "pre-wrap" }}>{version?.rendered_body}</p><h3>Villkor</h3><p style={{ whiteSpace: "pre-wrap" }}>{version?.rendered_terms}</p><div className="notice"><strong>Snapshot SHA-256:</strong><br /><code>{version?.snapshot_hash ?? version?.document_hash}</code><br /><strong>PDF SHA-256:</strong><br /><code>{request.canonical_document_sha256}</code></div>{document ? <p><Link href={`/api/public/contracts/${token}/document`} className="button button-secondary"><Download size={16} /> Ladda ned {document.file_name}</Link></p> : <p className="form-error">Det kanoniska PDF-dokumentet saknas.</p>}</section>
    {query.error ? <p className="form-error">{query.error}</p> : null}
    {inactive ? <div className="notice warning"><strong>Denna länk är inte längre aktiv.</strong><br />Kontakta avsändaren om du behöver en ny avtalsbegäran.</div> : <form action={respondPublicContract} className="form-stack"><input type="hidden" name="token" value={token} /><Field label="Ditt fullständiga namn" name="full_name" required /><label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, lineHeight: 1.5 }}><input type="checkbox" name="confirm" required style={{ marginTop: 4 }} /><span>Jag har läst avtalet och förstår att mitt namn, tidpunkt, IP-adress, webbläsarinformation och den exakta dokumenthashen sparas som bevis för mitt besked.</span></label><div className="grid grid-2"><button className="button button-primary" name="decision" value="accept"><ShieldCheck size={17} /> Acceptera avtalet</button><button className="button button-secondary" name="decision" value="decline">Avstå från avtalet</button></div></form>}
  </CardContent></Card><p className="muted" style={{ textAlign: "center", marginTop: 18 }}>Powered by Kundexa · {legalName} är avtalspart. Detta är dokumenterad acceptans, inte BankID-signering.</p></div></main>;
}
