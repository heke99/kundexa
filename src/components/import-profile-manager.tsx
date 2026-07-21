"use client";

import { useMemo, useState } from "react";

type Profile = {
  id: string;
  name: string;
  source_provider: string;
  source_website: string | null;
  format: string;
  worksheet_name: string | null;
  header_row: number;
  records_path: string | null;
  target_type: string;
  target_list_id: string | null;
  automatic_commit: boolean;
  current_version: number;
  field_mapping?: unknown;
};

type ListOption = { id: string; name: string };

const defaultMapping = {
  company: {
    company_name: { source: ["company_name", "företagsnamn", "name"], transforms: ["trim"], required: true },
    organization_number: { source: ["organization_number", "organisationsnummer", "org_nr"], transforms: ["organization_number"] },
    phone_e164: { source: ["company_phone", "telefon", "phone"], transforms: ["phone_e164"] },
    email: { source: ["company_email", "e-post", "email"], transforms: ["trim", "lowercase"] },
    website: { source: ["website", "webbplats"], transforms: ["trim", "lowercase"] },
    address_line1: { source: ["address", "adress"], transforms: ["trim"] },
    postal_code: { source: ["postal_code", "postnummer"], transforms: ["trim"] },
    city: { source: ["city", "ort"], transforms: ["trim", "titlecase"] },
    source_external_id: { source: ["id", "external_id", "source_external_id"], transforms: ["string", "trim"] },
    source_url: { source: ["url", "source_url"], transforms: ["trim"] },
  },
  contacts: {
    recordsPath: "owners",
    fields: {
      full_name: { source: ["name", "full_name", "namn"], transforms: ["trim"] },
      role: { source: ["role", "roll"], transforms: ["trim"] },
      phone_e164: { source: ["mobile", "mobil", "phone"], transforms: ["phone_e164"] },
      email: { source: ["email", "e-post"], transforms: ["trim", "lowercase"] },
      ownership_percentage: { source: ["ownership_percentage", "ägarandel"], transforms: ["percent"] },
      source_external_id: { source: ["id", "external_id"], transforms: ["string", "trim"] },
    },
  },
  mergePolicy: "safe_upsert",
};

export function ImportProfileManager({ profiles, lists }: { profiles: Profile[]; lists: ListOption[] }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(() => profiles.find((profile) => profile.id === selectedId), [profiles, selectedId]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(formData: FormData) {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const mappingText = String(formData.get("mapping") ?? "{}");
      const mapping = JSON.parse(mappingText) as unknown;
      const payload = {
        id: selectedId || null,
        name: String(formData.get("name") ?? ""),
        sourceProvider: String(formData.get("source_provider") ?? "file"),
        sourceWebsite: String(formData.get("source_website") ?? "").trim() || null,
        format: String(formData.get("format") ?? "auto"),
        worksheetName: String(formData.get("worksheet_name") ?? "").trim() || null,
        headerRow: Number(formData.get("header_row") ?? 1),
        recordsPath: String(formData.get("records_path") ?? "").trim() || null,
        mapping,
        targetType: String(formData.get("target_type") ?? "crm"),
        targetListId: String(formData.get("target_list_id") ?? "").trim() || null,
        automaticCommit: formData.get("automatic_commit") === "on",
      };
      const response = await fetch("/api/v1/import-profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Profilen kunde inte sparas");
      setMessage(`Profilen sparades som en ny versionslåst revision${result.id ? ` (${result.id.slice(0, 8)})` : ""}. Ladda om sidan för att se den i listan.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Profilen kunde inte sparas");
    } finally {
      setSaving(false);
    }
  }

  return <div className="form-stack">
    <label className="field"><span>Redigera befintlig profil</span><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">Skapa ny profil</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.current_version}</option>)}</select></label>
    <form key={selected?.id ?? "new"} action={submit} className="form-stack">
      <div className="form-grid two">
        <label className="field"><span>Namn</span><input name="name" required minLength={2} maxLength={120} defaultValue={selected?.name ?? "ParseHub – Allabolag företag och ägare"} /></label>
        <label className="field"><span>Källa</span><select name="source_provider" defaultValue={selected?.source_provider ?? "parsehub"}><option value="parsehub">ParseHub</option><option value="file">Manuell fil</option><option value="api">Annan API</option></select></label>
        <label className="field"><span>Webbkälla</span><select name="source_website" defaultValue={selected?.source_website ?? "allabolag"}><option value="allabolag">Allabolag</option><option value="merinfo">Merinfo</option><option value="other">Annan</option><option value="">Ingen</option></select></label>
        <label className="field"><span>Format</span><select name="format" defaultValue={selected?.format ?? "auto"}><option value="auto">Identifiera automatiskt</option><option value="json">JSON</option><option value="ndjson">NDJSON</option><option value="csv">CSV</option><option value="xlsx">XLSX</option></select></label>
        <label className="field"><span>JSON records path</span><input name="records_path" placeholder="data.companies[*]" defaultValue={selected?.records_path ?? "companies"} /></label>
        <label className="field"><span>Excel-arbetsblad</span><input name="worksheet_name" placeholder="Företag" defaultValue={selected?.worksheet_name ?? ""} /></label>
        <label className="field"><span>Rubrikrad</span><input name="header_row" type="number" min="1" max="100" defaultValue={selected?.header_row ?? 1} /></label>
        <label className="field"><span>Mål</span><select name="target_type" defaultValue={selected?.target_type ?? "crm"}><option value="crm">CRM/katalog</option><option value="list">CRM och lista</option><option value="review">Granskningskö</option></select></label>
        <label className="field"><span>Standardlista</span><select name="target_list_id" defaultValue={selected?.target_list_id ?? ""}><option value="">Ingen standardlista</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
      </div>
      <label className="field"><span>Versionsstyrd fältmappning (JSON)</span><textarea name="mapping" rows={24} spellCheck={false} defaultValue={JSON.stringify(selected?.field_mapping ?? defaultMapping, null, 2)} /></label>
      <label style={{ display: "flex", gap: 9, fontSize: 13 }}><input type="checkbox" name="automatic_commit" defaultChecked={selected?.automatic_commit ?? false} /> Automatisk commit efter validering (endast för betrodd och godkänd profil)</label>
      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      <button className="button button-primary" disabled={saving}>{saving ? "Sparar…" : selected ? "Spara ny profilversion" : "Skapa importprofil"}</button>
    </form>
  </div>;
}
