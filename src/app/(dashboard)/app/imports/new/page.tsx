import Link from "next/link";
import { Upload } from "@/components/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/server";

export default async function NewImportPage() {
  const supabase = await createClient();
  const [{ data: profiles }, { data: lists }] = await Promise.all([
    supabase.from("import_profiles").select("id,name,source_provider,source_website,current_version,records_path,worksheet_name").eq("active", true).order("name"),
    supabase.from("customer_lists").select("id,name,status,dialing_mode").in("status", ["draft", "active", "paused"]).order("name"),
  ]);
  return <>
    <PageHeader title="Ny import" description="Ladda upp resultat från ParseHub eller annan godkänd källa. Importen genomförs först efter förhandsgranskning." action={<div style={{ display: "flex", gap: 8 }}><Link className="button button-secondary" href="/app/imports/profiles">Skapa profil</Link><Link className="button button-secondary" href="/app/imports">Till översikten</Link></div>} />
    <div className="split-layout">
      <Card>
        <CardHeader><h2><Upload size={17} /> Fil och profil</h2><Badge>Steg 1–4</Badge></CardHeader>
        <CardContent>
          <form action="/api/v1/imports/file" method="post" encType="multipart/form-data" className="form-stack">
            <label className="field"><span>Importnamn</span><input name="name" required placeholder="Allabolag · Malmö · juli 2026" /></label>
            <label className="field"><span>Sparad importprofil</span><select name="profile_id" defaultValue=""><option value="">Automatisk mappning (engångsimport)</option>{profiles?.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.current_version}</option>)}</select></label>
            <label className="field"><span>JSON records path (vid behov)</span><input name="records_path" placeholder="data.companies eller companies[*]" /></label>
            <div className="form-grid two">
              <label className="field"><span>Excel-arbetsblad (valfritt)</span><input name="worksheet_name" placeholder="Företag" /></label>
              <label className="field"><span>Rubrikrad</span><input type="number" name="header_row" min="1" max="100" defaultValue="1" /></label>
            </div>
            <label className="field"><span>Mållista</span><select name="target_list_id" defaultValue=""><option value="">Endast CRM/katalog</option>{lists?.map((list) => <option key={list.id} value={list.id}>{list.name} · {list.dialing_mode}</option>)}</select></label>
            <label className="field"><span>JSON, CSV eller XLSX</span><input type="file" name="file" accept=".csv,.json,.jsonl,.ndjson,.xlsx,text/csv,application/json,application/x-ndjson,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label>
            <label style={{ display: "flex", gap: 9, fontSize: 13 }}><input type="checkbox" name="simulate" defaultChecked /> Kräv manuell granskning före commit</label>
            <button className="button button-primary"><Upload size={16} /> Ladda upp och validera</button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><h2>Kontroller före commit</h2></CardHeader>
        <CardContent>
          <div className="notice warning">Filen hashkontrolleras, malware-skannas, MIME-verifieras och parsas på servern. XLSX granskas även för orimlig kompressionsgrad.</div>
          <ul className="detail-list">
            <li>Organisationsnummer normaliseras och Luhn-valideras.</li>
            <li>Telefonnummer normaliseras till E.164 utan att ägarens mobil blir företagets växel.</li>
            <li>Kontaktpersoner lagras i det befintliga kontaktregistret.</li>
            <li>Befintliga kunder uppdateras enligt säker merge-policy.</li>
            <li>Listmedlemskap är idempotent och compliance styr om posten blir ringbar.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  </>;
}
