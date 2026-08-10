"use client";

import { useEffect, useMemo, useState } from "react";
import type { CustomerSearchOption } from "@/components/customer-search-select";

export function CustomerMultiSearchSelect({ name = "customer_ids", label = "Prospekt och kunder" }: { name?: string; label?: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerSearchOption[]>([]);
  const [selected, setSelected] = useState<Map<string, CustomerSearchOption>>(() => new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length < 2) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const url = new URL("/api/v1/customers", window.location.origin);
        url.searchParams.set("limit", "30");
        url.searchParams.set("q", normalizedQuery);
        const response = await fetch(url, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { data?: CustomerSearchOption[] };
        setResults(payload.data ?? []);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error("Customer multi-search failed", error);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const selectedValues = useMemo(() => [...selected.values()], [selected]);

  function toggle(customer: CustomerSearchOption) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(customer.id)) next.delete(customer.id); else next.set(customer.id, customer);
      return next;
    });
  }

  return <div className="form-stack">
    {selectedValues.map((customer) => <input key={customer.id} type="hidden" name={name} value={customer.id} />)}
    <label className="field">
      <span>Sök {label.toLowerCase()}</span>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Skriv minst två tecken" autoComplete="off" />
      <small>{loading ? "Söker…" : `${selectedValues.length} valda · högst 30 träffar per sökning`}</small>
    </label>
    {selectedValues.length ? <div className="selection-list">
      {selectedValues.map((customer) => <label className="check-row" key={customer.id}>
        <input type="checkbox" checked onChange={() => toggle(customer)} />
        <span><strong>{customer.display_name}</strong><small>{customer.phone_e164 ?? customer.email ?? customer.organization_number ?? "Kontaktuppgift saknas"}</small></span>
      </label>)}
    </div> : null}
    {query.trim().length >= 2 ? <div className="selection-list">
      {results.map((customer) => <label className="check-row" key={customer.id}>
        <input type="checkbox" checked={selected.has(customer.id)} onChange={() => toggle(customer)} />
        <span><strong>{customer.display_name}</strong><small>{customer.phone_e164 ?? customer.email ?? customer.organization_number ?? "Kontaktuppgift saknas"}</small></span>
      </label>)}
      {!loading && !results.length ? <p className="muted">Inga behöriga träffar.</p> : null}
    </div> : null}
  </div>;
}
