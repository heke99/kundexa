"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import SignaturePad from "signature_pad";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { cropCanvasAndExportToPNG, isCanvasBlocked, isValidSignatureCanvas } from "@/lib/signing/ported/docuseal-signature";

function PdfPage({ document, pageNumber, onError }: { document: PDFDocumentProxy; pageNumber: number; onError: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let cancel: (() => void) | undefined;
    void document.getPage(pageNumber).then(async page => {
      if (cancelled || !canvas.current) return;
      const viewport = page.getViewport({ scale: 1.25 });
      canvas.current.width = viewport.width;
      canvas.current.height = viewport.height;
      const render = page.render({ canvas: canvas.current, viewport });
      cancel = () => render.cancel();
      await render.promise;
    }).catch(() => { if (!cancelled) { setError(true); onError(); } });
    return () => { cancelled = true; cancel?.(); };
  }, [document, pageNumber, onError]);
  return <figure style={{ margin: "12px 0" }}><figcaption>Sida {pageNumber}</figcaption>{error ? <p role="alert">Den här sidan kunde inte visas. Öppna avtalets PDF och läs den före underskrift.</p> : null}<canvas aria-label={`Avtalets sida ${pageNumber}`} ref={canvas} style={{ display: "block", width: "100%", height: "auto", border: "1px solid #d7e1dc" }} /></figure>;
}

type Submission = { signerName: string; consent: true; signaturePng: string; idempotencyKey: string };

/** Draw/validate/crop flow ported from DocuSeal's submission_form; see NOTICE. */
export function NativeContractSigning({ documentUrl, contractTitle, expectedSignerName = "", submitUrl }: {
  documentUrl: string;
  contractTitle: string;
  expectedSignerName?: string;
  submitUrl: string;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [documentError, setDocumentError] = useState(false);
  const markDocumentError = useCallback(() => setDocumentError(true), []);
  const [name, setName] = useState(expectedSignerName);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const signaturePad = useRef<SignaturePad | null>(null);
  const submission = useRef<Submission | null>(null);
  const inFlight = useRef(false);
  const previousDestroy = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | undefined;
    void (async () => {
      await previousDestroy.current;
      const pdfjs = await import("pdfjs-dist");
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const task = pdfjs.getDocument({ url: documentUrl });
      destroy = () => task.destroy();
      const pdf = await task.promise;
      if (!cancelled) setDocument(pdf);
    })().catch(() => { if (!cancelled) setDocumentError(true); });
    return () => { cancelled = true; if (destroy) previousDestroy.current = destroy().catch(() => {}); };
  }, [documentUrl]);

  useEffect(() => {
    if (!canvas.current) return;
    if (isCanvasBlocked()) { setError("Webbläsaren blockerar ritytan. Tillåt ritning i webbläsaren och ladda om sidan."); return; }
    const element = canvas.current;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    element.width = Math.round(element.getBoundingClientRect().width * ratio);
    element.height = Math.round(220 * ratio);
    element.getContext("2d")?.scale(ratio, ratio);
    const pad = new SignaturePad(element, { penColor: "#17202a", minWidth: 1, maxWidth: 2.5 });
    const update = () => setHasSignature(!pad.isEmpty());
    pad.addEventListener("endStroke", update);
    signaturePad.current = pad;
    setReady(true);
    return () => { pad.removeEventListener("endStroke", update); pad.off(); signaturePad.current = null; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || signed) return;
    setError("");
    if (!submission.current) {
      const pad = signaturePad.current;
      if (!document || documentError) { setError("Avtalet måste kunna visas innan du skriver under. Ladda om sidan och försök igen."); return; }
      if (name.trim().length < 2 || !consent || !pad || !canvas.current || pad.isEmpty() || !isValidSignatureCanvas(pad.toData())) {
        setError("Fyll i ditt namn, rita din underskrift och bekräfta att du godkänner avtalet."); return;
      }
      inFlight.current = true;
      setBusy(true);
      try {
        const blob = await cropCanvasAndExportToPNG(canvas.current, { errorOnTooSmall: true });
        const signaturePng = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Underskriften kunde inte läsas. Rita den igen."));
          reader.readAsDataURL(blob);
        });
        submission.current = { signerName: name.trim(), consent: true, signaturePng, idempotencyKey: crypto.randomUUID() };
        pad.off();
        setLocked(true);
      } catch {
        setError("Underskriften kunde inte sparas. Rita en tydlig underskrift och försök igen.");
        setBusy(false);
        inFlight.current = false;
        return;
      }
    } else { inFlight.current = true; setBusy(true); }
    try {
      const response = await fetch(submitUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission.current) });
      const result = await response.json() as { status?: string };
      if (!response.ok || result.status !== "signed") throw new Error("submission_failed");
      setSigned(true);
    } catch {
      setError("Vi kunde inte bekräfta underskriften. Försök igen med knappen nedan. Samma underskrift skickas så att avtalet inte registreras två gånger.");
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <main className="page-content" style={{ maxWidth: 940, margin: "0 auto" }}>
    <h1>{contractTitle}</h1><h2>Elektronisk underskrift</h2>
    <p>Läs avtalet och skriv sedan under med din ritade underskrift. Detta är en enkel elektronisk underskrift utan BankID eller kontroll av din identitet.</p>
    <section aria-label="Avtal att läsa"><a className="button button-secondary" href={documentUrl} target="_blank" rel="noopener">Öppna avtalets PDF</a>
      {documentError ? <p role="alert">Avtalet kunde inte hämtas. Ladda om sidan och försök igen.</p> : document ? Array.from({ length: document.numPages }, (_, index) => <PdfPage key={index} document={document} pageNumber={index + 1} onError={markDocumentError} />) : <p role="status">Hämtar avtalet…</p>}
    </section>
    {signed ? <section role="status"><h2>Tack, din underskrift är mottagen.</h2><p>Avtalets slutliga PDF och underskriftsuppgifter sparas av Kundexa.</p></section> : <form onSubmit={submit} className="form-stack">
      <label className="field"><span>Ditt fullständiga namn</span><input name="signerName" autoComplete="name" value={name} minLength={2} maxLength={160} required readOnly={locked || busy} onChange={event => setName(event.target.value)} /></label>
      <label htmlFor="contract-signature">Rita din underskrift med mus eller finger</label>
      <canvas id="contract-signature" ref={canvas} aria-label="Rita din underskrift" role="img" style={{ width: "100%", maxWidth: 720, height: 220, touchAction: "none", border: "2px solid #638e83", background: "#fff" }} />
      <button type="button" className="button button-secondary" disabled={!ready || locked || busy} onClick={() => { signaturePad.current?.clear(); setHasSignature(false); setError(""); }}>Rensa underskriften</button>
      <label className="check-row"><input type="checkbox" checked={consent} disabled={locked || busy} onChange={event => setConsent(event.target.checked)} required /> Jag har läst avtalet och godkänner att skriva under det elektroniskt med underskriften ovan.</label>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      <button type="submit" className="button button-primary" disabled={busy || !ready || !document || documentError || !hasSignature || !consent || name.trim().length < 2}>{busy ? "Skickar underskriften…" : locked ? "Försök bekräfta underskriften igen" : "Skriv under avtalet"}</button>
    </form>}
    <p className="muted" style={{ marginTop: 24 }}>Underskriftsfunktionen använder delar av <a href="https://www.docuseal.com/" target="_blank" rel="noopener">DocuSeal</a>.</p>
  </main>;
}
