import Link from "next/link";
import { notFound } from "next/navigation";
import { Headphones, Phone } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { TranscriptionRetryButton } from "@/components/transcription-retry-button";

export default async function CallDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const [
    { data: call },
    { data: events },
    { data: recording },
    { data: transcript },
    { data: insights },
  ] = await Promise.all([
    supabase.from("calls").select("*,customers(display_name)").eq("id", id).single(),
    supabase.from("call_events").select("id,event_type,occurred_at,processing_status").eq("call_id", id).order("occurred_at"),
    supabase.from("call_recordings").select("id,status,mime_type,duration_seconds,size_bytes,retention_delete_at,deleted_at").eq("call_id", id).is("deleted_at", null).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    supabase.from("call_transcripts").select("status,raw_transcript,structured_transcript,generated_at,deleted_at").eq("call_id", id).eq("provider", "rinkel").maybeSingle(),
    supabase.from("call_insights").select("source,status,sentiment,topics,summary,generated_at").eq("call_id", id).order("generated_at", { ascending: false }),
  ]);
  if (!call) notFound();
  const customer = Array.isArray(call.customers) ? call.customers[0] : call.customers;
  const transcriptText = transcript?.raw_transcript
    ?? (transcript?.structured_transcript ? JSON.stringify(transcript.structured_transcript, null, 2) : null);

  return <>
    <PageHeader
      title={customer?.display_name ?? `${call.from_number} → ${call.to_number}`}
      description={`Rinkel-samtal ${formatDate(call.created_at)} · ${call.direction}`}
      action={<Link className="button button-secondary" href="/app/calls">Till samtalslistan</Link>}
    />
    <div className="grid grid-2">
      <Card><CardHeader><h2><Phone size={17} /> Samtalsstatus</h2><Badge className={call.status === "completed" ? "badge-success" : "badge-info"}>{call.status}</Badge></CardHeader><CardContent>
        <p><strong>Från:</strong> {call.from_number}</p>
        <p><strong>Till:</strong> {call.to_number}</p>
        <p><strong>Teknisk status:</strong> {call.provider_status ?? "Ej rapporterad"}</p>
        <p><strong>Providerresultat:</strong> {call.provider_outcome ?? "Ej rapporterat"}</p>
        {call.provider_cause ? <p><strong>Rinkel-orsak:</strong> {call.provider_cause}</p> : null}
        <p><strong>CRM-disposition:</strong> {call.disposition ?? "Ej registrerad"}</p>
        <p><strong>Längd:</strong> {call.duration_seconds ?? 0} sekunder</p>
        {call.notes ? <p><strong>Anteckning:</strong><br />{call.notes}</p> : null}
      </CardContent></Card>

      <Card><CardHeader><h2><Headphones size={17} /> Inspelning</h2><Badge>{recording?.status ?? call.recording_status}</Badge></CardHeader><CardContent>
        {recording && !recording.deleted_at
          ? <><audio controls preload="none" src={`/api/v1/calls/${id}/recording`} style={{ width: "100%" }}><track kind="captions" /></audio><p className="muted">Uppspelning kräver behörighet och loggas. Retention: {recording.retention_delete_at ? formatDate(recording.retention_delete_at) : "ej satt"}.</p></>
          : <p>Ingen tillgänglig inspelning.</p>}
      </CardContent></Card>

      <Card><CardHeader><h2>Transkribering</h2><Badge>{transcript?.status ?? call.transcription_status}</Badge></CardHeader><CardContent>
        {transcriptText ? <pre style={{ whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto" }}>{transcriptText}</pre> : <p>Transkribering är inte tillgänglig ännu.</p>}
        {transcript?.status === "pending" ? <TranscriptionRetryButton callId={id} /> : null}
      </CardContent></Card>

      <Card><CardHeader><h2>AI Insights</h2><Badge>{insights?.[0]?.status ?? call.insights_status}</Badge></CardHeader><CardContent>
        {insights?.length ? insights.map((item) => <div key={item.source} className="activity-line"><div><strong>{item.source} · {item.sentiment ?? "utan sentiment"}</strong><p>{item.summary ?? "Ingen sammanfattning"}</p><p className="muted">{item.topics?.join(", ")}</p></div></div>) : <p>Inga insights tillgängliga ännu.</p>}
      </CardContent></Card>
    </div>
    <Card style={{ marginTop: 16 }}><CardHeader><h2>Providerhändelser</h2><Badge>{events?.length ?? 0}</Badge></CardHeader><CardContent>
      {events?.map((event) => <div className="activity-line" key={event.id}><span className="activity-dot" /><div><strong>{event.event_type}</strong><p>{formatDate(event.occurred_at)} · {event.processing_status ?? "mottagen"}</p></div></div>)}
    </CardContent></Card>
  </>;
}
