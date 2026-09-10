"use client";

import { useRef, useState } from "react";
import { Upload } from "@/components/icons";

type Target = "body_template" | "terms_template";

// A team leader writes the agreement in Word, not in a textarea. This reads the
// uploaded document into the field they are already filling in, so authoring a
// template is "upload, then mark where the customer's details go" rather than
// retyping the whole contract.
export function ContractTemplateDocumentUpload({ target, label }: { target: Target; label: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"idle" | "reading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  async function upload(file: File) {
    setState("reading");
    setError(null);
    setLoaded(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/v1/contract-templates/extract-text", { method: "POST", body });
      const payload = await response.json() as { text?: string; error?: string };
      if (!response.ok || !payload.text) {
        setError(payload.error ?? "Dokumentet kunde inte läsas.");
        return;
      }
      // The field belongs to the surrounding server-rendered form, so write to it
      // through the DOM rather than lifting the whole form into client state.
      const field = document.querySelector<HTMLTextAreaElement>(`textarea[name="${target}"]`);
      if (!field) {
        setError("Fältet kunde inte hittas på sidan.");
        return;
      }
      field.value = payload.text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      setLoaded(`${file.name} · ${payload.text.length} tecken`);
    } catch {
      setError("Dokumentet kunde inte läsas.");
    } finally {
      setState("idle");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return <div className="form-stack">
    <input
      ref={inputRef}
      type="file"
      accept=".docx,.txt,.md,.html,.htm"
      style={{ display: "none" }}
      onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }}
    />
    <button
      type="button"
      className="button button-secondary"
      disabled={state === "reading"}
      onClick={() => inputRef.current?.click()}
    >
      <Upload size={15} /> {state === "reading" ? "Läser dokumentet…" : label}
    </button>
    {loaded ? <p className="muted">Inläst: {loaded}. Markera var kundens uppgifter ska in innan du sparar.</p> : null}
    {error ? <p className="form-error">{error}</p> : null}
  </div>;
}
