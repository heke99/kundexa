"use client";

import { useState } from "react";
import { Field } from "@/components/ui/form-field";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordPolicyHint } from "@/lib/security/password-policy-config";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-_=?.";

function generatePassword(length = 18) {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let password = Array.from(bytes, (value) => ALPHABET[value % ALPHABET.length]).join("");
  if (!/[A-Z]/.test(password)) password = `A${password.slice(1)}`;
  if (!/[a-z]/.test(password)) password = `${password.slice(0, 1)}a${password.slice(2)}`;
  if (!/\d/.test(password)) password = `${password.slice(0, 2)}7${password.slice(3)}`;
  if (!/[^A-Za-z0-9]/.test(password)) password = `${password.slice(0, 3)}!${password.slice(4)}`;
  return password;
}

export function TemporaryPasswordFields() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const generate = () => {
    const next = generatePassword();
    setPassword(next);
    setConfirmation(next);
    setRevealed(true);
    setCopyState("idle");
  };

  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return <>
    <div className="form-grid">
      <Field
        label="Tillfälligt lösenord"
        name="temporary_password"
        type={revealed ? "text" : "password"}
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        autoComplete="new-password"
        value={password}
        onChange={(event) => { setPassword(event.target.value); setCopyState("idle"); }}
        hint={passwordPolicyHint()}
        required
      />
      <Field
        label="Bekräfta tillfälligt lösenord"
        name="temporary_password_confirm"
        type={revealed ? "text" : "password"}
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        autoComplete="new-password"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        required
      />
    </div>
    <div className="button-row">
      <button type="button" className="button button-secondary button-sm" onClick={generate}>Generera säkert lösenord</button>
      <button type="button" className="button button-secondary button-sm" onClick={() => setRevealed((value) => !value)} disabled={!password}>{revealed ? "Dölj" : "Visa"}</button>
      <button type="button" className="button button-secondary button-sm" onClick={copy} disabled={!password}>Kopiera</button>
    </div>
    <small className="muted" aria-live="polite">{copyState === "copied" ? "Lösenordet är kopierat. Dela det via en separat säker kanal." : copyState === "failed" ? "Kopiering stöds inte här. Markera lösenordet och kopiera manuellt." : "Kopiera lösenordet innan du skapar användaren. Det lagras inte i Kundexa och visas inte efteråt."}</small>
  </>;
}
