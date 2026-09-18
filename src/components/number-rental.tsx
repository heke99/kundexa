"use client";

import { useState } from "react";
import { rentPhoneNumber } from "@/app/actions/telephony";

type AvailableNumber = {
  phoneNumber: string;
  regionCode: string;
  numberType: string;
  capabilities: string[];
  monthlyPrice: { amount: string; currency: string } | null;
  setupPrice: { amount: string; currency: string } | null;
  documentationRequired: boolean;
};

/**
 * Hyr ett nummer utan att lämna Kundexa.
 *
 * Sökningen är gratis, hyrningen är inte det. Därför är de två tydligt skilda
 * steg med en bekräftelse emellan, och priset står på varje rad i stället för
 * i en fotnot: den som trycker ska veta vad den trycker på.
 *
 * Numren måste origineras i Sverige för att svenska mottagare ska se dem. Ett
 * svenskt nummer som origineras utomlands blockeras av operatörerna enligt PTS
 * föreskrift, så landsvalet är inte en kosmetisk filtrering.
 */
export function NumberRental() {
  const [regionCode, setRegionCode] = useState("SE");
  const [numberType, setNumberType] = useState("LOCAL");
  const [pattern, setPattern] = useState("");
  const [numbers, setNumbers] = useState<AvailableNumber[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    setError(null);
    setConfirming(null);
    try {
      const query = new URLSearchParams({ regionCode, numberType });
      if (pattern) query.set("pattern", pattern);
      const response = await fetch(`/api/v1/telephony/numbers/available?${query}`);
      const data = await response.json().catch(() => null) as { numbers?: AvailableNumber[]; message?: string } | null;
      if (!response.ok) {
        setNumbers(null);
        setError(data?.message ?? "Sökningen kunde inte genomföras.");
        return;
      }
      setNumbers(data?.numbers ?? []);
    } catch {
      setNumbers(null);
      setError("Sökningen kunde inte genomföras.");
    } finally {
      setSearching(false);
    }
  }

  function price(number: AvailableNumber) {
    if (!number.monthlyPrice) return "Pris visas inte av leverantören";
    const monthly = `${number.monthlyPrice.amount} ${number.monthlyPrice.currency}/mån`;
    return number.setupPrice && Number(number.setupPrice.amount) > 0
      ? `${monthly} · ${number.setupPrice.amount} ${number.setupPrice.currency} i startavgift`
      : monthly;
  }

  return <div className="form-stack">
    <p className="muted">
      Numret måste origineras i Sverige för att svenska mottagare ska se det. Ett svenskt
      nummer som origineras utomlands blockeras av operatörerna.
    </p>

    <div className="form-grid">
      <label className="field">
        <span>Land</span>
        <select value={regionCode} onChange={(event) => setRegionCode(event.target.value)}>
          <option value="SE">Sverige</option>
          <option value="NO">Norge</option>
          <option value="DK">Danmark</option>
          <option value="FI">Finland</option>
        </select>
      </label>
      <label className="field">
        <span>Typ</span>
        <select value={numberType} onChange={(event) => setNumberType(event.target.value)}>
          <option value="LOCAL">Fast nummer</option>
          <option value="MOBILE">Mobilnummer</option>
          <option value="TOLL_FREE">Frisamtal</option>
        </select>
      </label>
      <label className="field">
        <span>Siffror numret ska innehålla</span>
        <input
          value={pattern}
          onChange={(event) => setPattern(event.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
          placeholder="Valfritt, t.ex. 8"
          inputMode="numeric"
        />
      </label>
    </div>

    <button type="button" className="button button-secondary" onClick={() => void search()} disabled={searching}>
      {searching ? "Söker…" : "Sök lediga nummer"}
    </button>

    {error ? <div className="notice warning">{error}</div> : null}

    {numbers?.length === 0 ? <div className="notice">Inga lediga nummer matchade sökningen.</div> : null}

    {numbers?.length ? <div className="grid" style={{ gap: 8 }}>
      {numbers.map((number) => <div className="activity-line" key={number.phoneNumber}>
        <span className="activity-dot">{number.numberType === "MOBILE" ? "M" : number.numberType === "TOLL_FREE" ? "F" : "L"}</span>
        <div style={{ flex: 1 }}>
          <strong>{number.phoneNumber}</strong>
          <p>
            {price(number)}
            {number.capabilities.length ? ` · ${number.capabilities.map((capability) => capability === "voice" ? "röst" : "SMS").join(" och ")}` : " · kapabiliteter okända"}
          </p>
        </div>
        {number.documentationRequired
          // Ett nummer som kräver identitetshandlingar går inte att hyra med ett
          // anrop -- det kräver leverantörens beställningsflöde. En hyrknapp här
          // hade misslyckats varje gång.
          ? <span className="badge badge-warning">Kräver dokumentation</span>
          : confirming === number.phoneNumber
          // Två steg, därför att det andra kostar pengar varje månad tills
          // någon säger upp numret hos leverantören.
          ? <form action={rentPhoneNumber} className="toolbar-left">
            <input type="hidden" name="phone_number" value={number.phoneNumber} />
            <button className="button button-primary button-sm">Ja, hyr {number.phoneNumber}</button>
            <button type="button" className="button button-ghost button-sm" onClick={() => setConfirming(null)}>Avbryt</button>
          </form>
          : <button type="button" className="button button-secondary button-sm" onClick={() => setConfirming(number.phoneNumber)}>
            Hyr
          </button>}
      </div>)}
    </div> : null}
  </div>;
}
