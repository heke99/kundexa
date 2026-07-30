"use client";

import { useState } from "react";

export function TranscriptionRetryButton({ callId }: { callId: string }) {
  const [state, setState] = useState<"idle" | "pending" | "queued" | "error">("idle");
  async function retry() {
    setState("pending");
    const response = await fetch(`/api/v1/calls/${callId}/transcription/retry`, { method: "POST" });
    setState(response.ok ? "queued" : "error");
  }
  return <div>
    <button className="button button-secondary" type="button" onClick={retry} disabled={state === "pending" || state === "queued"}>
      {state === "pending" ? "Köar…" : state === "queued" ? "Köad" : "Försök hämta igen"}
    </button>
    {state === "error" ? <p className="form-error">Försöket kunde inte köas.</p> : null}
  </div>;
}
