"use client";

/** Existing authenticated pages and server actions stay inside the same frame. */
export function ContractWorkspace({ href, customerName, onClose }: {
  href: string;
  customerName: string;
  onClose: () => void;
}) {
  return <section aria-label="Skapa och skicka avtal" className="card">
    <div className="card-header">
      <div><h2>Avtal · {customerName}</h2><p className="muted">Välj produkt, granska avtalet och kontrollera mottagaren före utskick. Ringningen fortsätter när du går tillbaka.</p></div>
      <button type="button" className="button button-secondary" onClick={onClose}>Tillbaka till ringningen</button>
    </div>
    <iframe title={`Avtal för ${customerName}`} src={href} style={{ width: "100%", height: "75vh", minHeight: 480, border: 0 }} />
    <p className="muted" style={{ padding: 16 }}>Se utskickets bekräftelse i avtalet innan du går tillbaka. Du kan också lämna avtalet oskickat och fortsätta senare under Mina avtal.</p>
  </section>;
}
