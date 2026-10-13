import { notFound } from "next/navigation";
import { publicSigningLink } from "@/lib/signing/public-link";

export const dynamic = "force-dynamic";
export default async function SigningPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await publicSigningLink(token);
  if (!result) notFound();
  const completed = result.envelope.status === "completed";
  return <main className="public-page" style={{ maxWidth: 680, margin: "48px auto", padding: 24 }}>
    <h1>{completed ? "Ditt avtal är signerat" : "Granska och signera ditt avtal"}</h1>
    <p>{result.contract.title} · {result.contract.contract_number}</p>
    {completed ? <>
      <p>Här kan du hämta din signerade kopia. En kopia skickas också till din e-post.</p>
      <a className="button button-primary" href={`/api/public/signing/${token}/document`}>Hämta signerat avtal</a>
    </> : <>
      <p>Kontrollera uppgifterna i avtalet innan du skriver under.</p>
      <a className="button button-secondary" href={`/api/public/signing/${token}/document`}>Läs avtalet</a>
      {result.envelope.provider_envelope_id
        ? <form method="post" action={`/api/public/signing/${token}/session`} style={{ marginTop: 16 }}>
            <button className="button button-primary">Öppna signeringen</button>
          </form>
        : <p>Avtalet förbereds. Ladda om sidan om en stund.</p>}
      <p>När signeringen är klar finns den signerade kopian på den här sidan.</p>
    </>}
  </main>;
}
