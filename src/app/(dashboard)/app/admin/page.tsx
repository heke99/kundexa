import { Settings } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";
import { ModuleOverview } from "@/components/module-overview";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/form-field";
import { saveLegalEntity, toggleTenantFeature } from "@/app/actions/admin";
import { normalizeOrganizationNumber } from "@/lib/imports/organization-number";

const featureLabels: Record<string, string> = {
  outbound_calls: "Utgående samtal",
  outbound_sms: "Utgående SMS",
  outbound_email: "Utgående e-post",
  contract_delivery_sms: "Avtalsutskick via SMS",
  contract_delivery_email: "Avtalsutskick via e-post",
  call_recording: "Samtalsinspelning",
  data_enrichment: "Databerikning",
  mass_campaigns: "Masskampanjer",
  exports: "Exporter",
};



// Sending a contract checks two flags, not one: the channel's own gate and the
// general outbound gate. With only the delivery flag on, the send fails at
// `outbound_email_feature_disabled` — a green row that does nothing.
const featurePrerequisites: Record<string, string> = {
  contract_delivery_email: "outbound_email",
  contract_delivery_sms: "outbound_sms",
};

function blockedPrerequisite(
  feature: { feature_key: string; enabled: boolean },
  features: { feature_key: string; enabled: boolean }[] | null,
): string | null {
  if (!feature.enabled) return null;
  const required = featurePrerequisites[feature.feature_key];
  if (!required) return null;
  return features?.some((other) => other.feature_key === required && other.enabled) ? null : required;
}

type LegalEntityRow = {
  organization_number: string | null;
  country_code: string | null;
  address_line1: string | null;
  postal_code: string | null;
  city: string | null;
};

/**
 * What would make this company wrong on a contract.
 *
 * The organisation number is checked against the same rule the customer import
 * has always used, because until now nothing checked the seller's own — which is
 * how an eleven-digit value ended up on the party that signs.
 */
function legalEntityProblems(entity: LegalEntityRow): string[] {
  const problems: string[] = [];
  const swedish = (entity.country_code ?? "SE").toUpperCase() === "SE";
  if (!entity.organization_number) {
    problems.push("Organisationsnummer saknas — det trycks på varje avtal.");
  } else if (swedish && !normalizeOrganizationNumber(entity.organization_number, { allowPerson: true }).valid) {
    problems.push(`"${entity.organization_number}" är inget giltigt svenskt organisationsnummer. Det skrivs ut som avsändarens organisationsnummer på avtalet.`);
  }
  const missingAddress = [
    !entity.address_line1 && "adress",
    !entity.postal_code && "postnummer",
    !entity.city && "ort",
  ].filter(Boolean);
  if (missingAddress.length) problems.push(`Avsändaradressen är ofullständig: ${missingAddress.join(", ")} saknas.`);
  return problems;
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: settings }, { data: features }, { data: limits }, { data: legalEntities }] = await Promise.all([
    supabase.from("tenant_settings").select("*").single(),
    supabase.from("tenant_features").select("*").order("feature_key"),
    supabase.from("usage_limits").select("*").order("metric"),
    supabase.from("tenant_legal_entities").select("*").eq("active", true).order("is_default", { ascending: false }).order("legal_name"),
  ]);

  return <ModuleOverview title="Administration" description="Juridiska avsändare, funktionsspärrar, compliance, retention och användningsgränser." icon={Settings} features={["Feature policies per tenant och team", "Juridiska avsändarbolag", "Ringdagar och tillåtna tider", "Kostnadstak per kanal", "Branding och avtalsidentitet"]}>
    {params.error ? <p className="form-error">{params.error}</p> : null}
    {params.message ? <div className="notice">{params.message}</div> : null}
    <div className="split-layout">
      <Card>
        <CardHeader><h2>Funktionsspärrar</h2><Badge>{features?.filter((feature) => feature.enabled).length ?? 0} aktiva</Badge></CardHeader>
        <CardContent>
          {features?.map((feature) => <div className="activity-line" key={feature.feature_key}>
            <span className="activity-dot"><Settings size={14} /></span>
            <div>
              <strong>{featureLabels[feature.feature_key] ?? feature.feature_key}</strong>
              <p>{feature.enabled ? "Tillåten för tenanten" : "Blockerad i databasen"}</p>
              {blockedPrerequisite(feature, features)
                ? <p className="form-error">Får ingen effekt: {featureLabels[blockedPrerequisite(feature, features)!]} är avstängd, och utskicket kräver båda.</p>
                : null}
            </div>
            <form action={toggleTenantFeature}>
              <input type="hidden" name="feature_key" value={feature.feature_key} />
              <input type="hidden" name="enabled" value={feature.enabled ? "false" : "true"} />
              <button className={`button ${feature.enabled ? "button-secondary" : "button-primary"}`}>{feature.enabled ? "Stäng av" : "Aktivera"}</button>
            </form>
          </div>)}
          <div className="notice warning" style={{ marginTop: 15 }}>Aktivering öppnar endast den interna funktionsspärren. Leverantörsavtal, credentials, nummer/domän och rättslig grund måste också vara klara.</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h2>Juridiska avsändarbolag</h2><Badge>{legalEntities?.length ?? 0}</Badge></CardHeader>
        <CardContent>
          {legalEntities?.map((entity) => {
            // This company is the signing party on every contract it is used for,
            // and its details are rendered into the document. A number that was
            // saved before the write path validated it is still in the table, so
            // say so here rather than letting it reach a customer.
            const problems = legalEntityProblems(entity);
            return <div className="activity-line" key={entity.id}>
              <span className="activity-dot"><Settings size={14} /></span>
              <div>
                <strong>{entity.legal_name}</strong>
                <p>{entity.organization_number ?? "Organisationsnummer saknas"} · {entity.city ?? "Ort saknas"}</p>
                {problems.length ? <p className="form-error">{problems.join(" ")}</p> : null}
              </div>
              <Badge className={problems.length ? "badge-danger" : entity.is_default ? "badge-success" : ""}>
                {problems.length ? "Behöver rättas" : entity.is_default ? "Standard" : "Aktiv"}
              </Badge>
            </div>;
          })}
          <form action={saveLegalEntity} className="form-stack" style={{ marginTop: 18 }}>
            <Field label="Juridiskt namn" name="legal_name" required />
            <Field label="Organisationsnummer" name="organization_number" />
            <Field label="Adress" name="address_line1" />
            <Field label="Postnummer" name="postal_code" />
            <Field label="Ort" name="city" />
            <Field label="Landkod" name="country_code" defaultValue="SE" required />
            <Field label="E-post" name="email" type="email" />
            <Field label="Telefon i E.164" name="phone_e164" placeholder="+4640123456" />
            <Field label="Webbplats" name="website" />
            <label><input type="checkbox" name="is_default" /> Använd som standardpart i nya avtal</label>
            <button className="button button-primary">Lägg till juridiskt bolag</button>
          </form>
        </CardContent>
      </Card>
    </div>
    <Card>
      <CardHeader><h2>Compliance och användningsgränser</h2></CardHeader>
      <CardContent>
        <div className="notice">Aktuell compliancekonfiguration: {JSON.stringify(settings?.compliance ?? {})}</div>
        {limits?.map((limit) => <p key={`${limit.metric}-${limit.period}`} className="muted">{limit.metric}: {limit.current_value} / {limit.hard_limit ?? "obegränsat"} per {limit.period}</p>)}
      </CardContent>
    </Card>
  </ModuleOverview>;
}
