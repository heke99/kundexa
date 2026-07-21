"use client";

import { useState } from "react";

type Profile = { id: string; name: string; current_version: number };
type Project = { id: string; project_name: string; source_website: string | null; active: boolean; created_at: string };

export function ParseHubProjectManager({ profiles, projects }: { profiles: Profile[]; projects: Project[] }) {
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(formData: FormData) {
    setSaving(true);
    setError("");
    setWebhookUrl("");
    try {
      const response = await fetch("/api/v1/integrations/parsehub/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectName: String(formData.get("project_name") ?? ""),
          projectToken: String(formData.get("project_token") ?? ""),
          apiKey: String(formData.get("api_key") ?? ""),
          importProfileId: String(formData.get("import_profile_id") ?? ""),
          sourceWebsite: String(formData.get("source_website") ?? "other"),
        }),
      });
      const result = await response.json() as { webhookUrl?: string; error?: string };
      if (!response.ok || !result.webhookUrl) throw new Error(result.error ?? "ParseHub-projektet kunde inte sparas");
      setWebhookUrl(result.webhookUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ParseHub-projektet kunde inte sparas");
    } finally {
      setSaving(false);
    }
  }

  return <div className="grid grid-2">
    <div className="form-stack">
      <form action={submit} className="form-stack">
        <label className="field"><span>Projektnamn</span><input name="project_name" required minLength={2} placeholder="Allabolag – Malmö företag" /></label>
        <label className="field"><span>Webbkälla</span><select name="source_website" defaultValue="allabolag"><option value="allabolag">Allabolag</option><option value="merinfo">Merinfo</option><option value="other">Annan</option></select></label>
        <label className="field"><span>Importprofil</span><select name="import_profile_id" required defaultValue=""><option value="" disabled>Välj profil</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.current_version}</option>)}</select></label>
        <label className="field"><span>ParseHub project token</span><input name="project_token" type="password" required autoComplete="off" /></label>
        <label className="field"><span>ParseHub API-nyckel</span><input name="api_key" type="password" required autoComplete="off" /></label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="button button-primary" disabled={saving || profiles.length === 0}>{saving ? "Krypterar…" : "Kryptera och anslut ParseHub"}</button>
      </form>
      {webhookUrl ? <div className="notice warning"><strong>Kopiera webhook-adressen nu.</strong><p>Den hemliga adressen visas endast i detta svar.</p><textarea readOnly rows={5} value={webhookUrl} onFocus={(event) => event.currentTarget.select()} /></div> : null}
    </div>
    <div>
      <h3>Registrerade projekt</h3>
      {projects.length === 0 ? <p className="muted">Inga ParseHub-projekt är registrerade ännu.</p> : projects.map((project) => <div className="activity-line" key={project.id}><div><strong>{project.project_name}</strong><p>{project.source_website ?? "annan källa"} · {project.active ? "aktiv" : "inaktiv"}</p></div></div>)}
    </div>
  </div>;
}
