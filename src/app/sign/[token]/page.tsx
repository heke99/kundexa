import { nativeSigningSession } from "@/lib/signing/orchestration";
import { NativeContractSigning } from "@/components/contracts/native-contract-signing";
export const dynamic = "force-dynamic";
export default async function NativeSigningPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await nativeSigningSession(token).catch(() => null);
  if (!session) return <main className="page"><h1>Signeringslänken är inte tillgänglig</h1><p>Kontakta avsändaren för en aktuell länk.</p></main>;
  if (session.completed) return <main className="page"><h1>Avtalet är undertecknat</h1><p>Din underskrift och avtalsversionen har sparats. En bekräftelse med avtalskopian skickas till dig.</p></main>;
  return <main className="page"><NativeContractSigning documentUrl={`/api/sign/${token}`} contractTitle={session.title} expectedSignerName={session.recipientName} submitUrl={`/api/sign/${token}/submit`} /></main>;
}
