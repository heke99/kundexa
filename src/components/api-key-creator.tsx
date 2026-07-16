"use client";

import { useState } from "react";
import { KeyRound } from "@/components/icons";

const scopes = [
  ["customers:read", "Läs kunder"], ["customers:write", "Ändra kunder"],
  ["contracts:read", "Läs avtal"], ["contracts:write", "Ändra avtal"],
  ["calls:create", "Starta samtal"], ["messages:send", "Skicka meddelanden"],
  ["imports:write", "Hantera importer"], ["reports:read", "Läs rapporter"],
  ["directory:read", "Sök katalog"], ["directory:refresh", "Beställ berikning"],
  ["segments:write", "Hantera segment"], ["providers:manage", "Hantera datakällor"],
] as const;

export function ApiKeyCreator() {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const selectedScopes = form.getAll("scopes").map(String);
    const response = await fetch("/api/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: form.get("name"), scopes: selectedScopes }),
      headers: { "content-type": "application/json" },
    });
    const data = await response.json();
    if (!response.ok) setError(data.error ?? "Kunde inte skapa nyckel");
    else setKey(data.key);
    setLoading(false);
  }

  return <form onSubmit={submit} className="form-stack">
    <label className="field"><span>Nyckelnamn</span><input name="name" required /></label>
    <fieldset className="field">
      <span>Scopes</span>
      {scopes.map(([scope, label]) => <label key={scope}><input type="checkbox" name="scopes" value={scope} defaultChecked={["customers:read", "contracts:read", "directory:read"].includes(scope)} /> {label} <code>{scope}</code></label>)}
    </fieldset>
    <button className="button button-primary" disabled={loading}><KeyRound size={16} />{loading ? "Skapar…" : "Skapa API-nyckel"}</button>
    {error ? <p className="form-error">{error}</p> : null}
    {key ? <div className="notice warning"><strong>Kopiera nyckeln nu. Den visas inte igen.</strong><div className="code" style={{ marginTop: 10 }}>{key}</div></div> : null}
  </form>;
}
