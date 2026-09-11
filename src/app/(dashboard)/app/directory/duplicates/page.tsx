import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, RefreshCw } from "@/components/icons";
import { getAppContext, isAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isJsonObject } from "@/lib/supabase/json";
import { mergeDirectoryEntities, rejectDuplicateCandidate, undoDirectoryMerge } from "@/app/actions/directory";
import { formatDate } from "@/lib/utils";

// Duplicates are detected during ingestion: two master entities that share an
// identity key — organisation number, external id, phone, email, website or
// name+postcode — become a pending candidate. Nothing ever read that queue, so
// the detection ran and the suggestions accumulated unseen. This is the review
// surface for them.

const matchMethodLabels: Record<string, string> = {
  organization_number: "Samma organisationsnummer",
  external_id: "Samma externa id",
  phone: "Samma telefonnummer",
  email: "Samma e-postadress",
  website_domain: "Samma webbdomän",
  name_postal: "Samma namn och postnummer",
};

type EntityCard = { id: string; name: string; organizationNumber: string | null; city: string | null };

function entityFrom(id: string, projection: unknown): EntityCard {
  const candidate = Array.isArray(projection) ? projection[0] : projection;
  const row = isJsonObject(candidate) ? candidate : {};
  return {
    id,
    name: typeof row.canonical_name === "string" ? row.canonical_name : "Licensierad katalogpost",
    organizationNumber: typeof row.organization_number === "string" ? row.organization_number : null,
    city: typeof row.city === "string" ? row.city : null,
  };
}

function EntitySummary({ entity, label }: { entity: EntityCard; label: string }) {
  return <div className="form-section">
    <span className="muted">{label}</span>
    <Link href={`/app/directory/${entity.id}`}><strong>{entity.name}</strong></Link>
    <p className="muted">{entity.organizationNumber ?? "Organisationsnummer saknas"} · {entity.city ?? "Ort saknas"}</p>
  </div>;
}

export default async function DirectoryDuplicatesPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const context = await getAppContext();
  const mayResolve = isAdmin(context.role);
  const admin = createAdminClient();

  const [{ data: candidates }, { data: decisions }] = await Promise.all([
    admin.from("duplicate_candidates")
      .select("id,left_entity_id,right_entity_id,match_method,confidence,created_at")
      .eq("tenant_id", context.tenantId).eq("status", "pending")
      .order("confidence", { ascending: false }).order("created_at", { ascending: false }).limit(50),
    admin.from("merge_decisions")
      .select("id,target_entity_id,source_entity_id,decision,decided_by,decided_at")
      .eq("tenant_id", context.tenantId).eq("decision", "merged").is("undone_at", null)
      .order("decided_at", { ascending: false }).limit(15),
  ]);

  // The projection is the licence-filtered view of an entity, so the queue shows
  // exactly what this tenant is allowed to see — the same fields as the detail page.
  const entityIds = [...new Set([
    ...(candidates ?? []).flatMap((row) => [row.left_entity_id, row.right_entity_id]),
    ...(decisions ?? []).flatMap((row) => [row.target_entity_id, row.source_entity_id]),
  ])];
  const projections = new Map(await Promise.all(entityIds.map(async (id) => {
    const { data } = await admin.rpc("directory_entity_projection_for_tenant", { p_tenant_id: context.tenantId, p_entity_id: id });
    return [id, entityFrom(id, data)] as const;
  })));
  const entity = (id: string) => projections.get(id) ?? entityFrom(id, null);

  return <>
    <PageHeader
      title="Dubbletter i katalogen"
      description="Poster som delar en identitetsnyckel föreslås som dubbletter vid inläsning. Sammanslagning flyttar identitetsnycklar och källkopplingar till den post du behåller."
      action={<Link className="button button-secondary" href="/app/directory">Till katalogen</Link>}
    />
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice success">{params.message}</div> : null}

    <Card>
      <CardHeader><h2><Users size={17} /> Förslag att granska</h2><Badge>{candidates?.length ?? 0}</Badge></CardHeader>
      <CardContent>
        {!candidates?.length
          ? <p className="muted">Inga öppna dubblettförslag. Nya upptäcks automatiskt när katalogdata läses in.</p>
          : candidates.map((candidate) => {
            const left = entity(candidate.left_entity_id);
            const right = entity(candidate.right_entity_id);
            // Confidence is 1.0 only for an organisation number or an external id.
            // A shared phone number scores 0.8 and is often a switchboard, so the
            // distinction is worth showing rather than averaging away.
            const certain = Number(candidate.confidence) >= 1;
            return <div className="form-section" key={candidate.id} style={{ marginBottom: 18 }}>
              <div className="toolbar-left">
                <Badge className={certain ? "badge-success" : "badge-warning"}>
                  {matchMethodLabels[candidate.match_method] ?? candidate.match_method}
                </Badge>
                <span className="muted">{Math.round(Number(candidate.confidence) * 100)}% säkerhet · upptäckt {formatDate(candidate.created_at)}</span>
              </div>
              <div className="grid grid-2" style={{ marginTop: 10 }}>
                <EntitySummary entity={left} label="Post A" />
                <EntitySummary entity={right} label="Post B" />
              </div>
              {mayResolve ? <div className="toolbar-left" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <form action={mergeDirectoryEntities}>
                  <input type="hidden" name="target_entity_id" value={left.id} />
                  <input type="hidden" name="source_entity_id" value={right.id} />
                  <button className="button button-primary button-sm">Behåll A, slå in B</button>
                </form>
                <form action={mergeDirectoryEntities}>
                  <input type="hidden" name="target_entity_id" value={right.id} />
                  <input type="hidden" name="source_entity_id" value={left.id} />
                  <button className="button button-primary button-sm">Behåll B, slå in A</button>
                </form>
                <form action={rejectDuplicateCandidate}>
                  <input type="hidden" name="candidate_id" value={candidate.id} />
                  <button className="button button-ghost button-sm">Inte en dubblett</button>
                </form>
              </div> : <p className="muted" style={{ marginTop: 12 }}>Endast läsbehörighet. En ägare eller administratör avgör förslaget.</p>}
            </div>;
          })}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><h2><RefreshCw size={16} /> Sammanslagningar som kan ångras</h2><Badge>{decisions?.length ?? 0}</Badge></CardHeader>
      <CardContent>
        {!decisions?.length
          ? <p className="muted">Inga sammanslagningar gjorda ännu.</p>
          : decisions.map((decision) => {
            const target = entity(decision.target_entity_id);
            const source = entity(decision.source_entity_id);
            return <div className="activity-line" key={decision.id}>
              <div style={{ flex: 1 }}>
                <strong>{source.name}</strong> slogs in i <strong>{target.name}</strong>
                <p className="muted">{formatDate(decision.decided_at)}</p>
              </div>
              {mayResolve ? <form action={undoDirectoryMerge}>
                <input type="hidden" name="decision_id" value={decision.id} />
                <button className="button button-secondary button-sm"><RefreshCw size={14} /> Ångra</button>
              </form> : null}
            </div>;
          })}
      </CardContent>
    </Card>
  </>;
}
