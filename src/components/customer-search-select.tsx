"use client";

import { useEffect, useMemo, useState } from "react";

export type CustomerSearchOption = {
  id: string;
  customer_type: "person" | "company" | string;
  display_name: string;
  email: string | null;
  phone_e164: string | null;
  organization_number: string | null;
  do_not_call?: boolean;
  do_not_sms?: boolean;
  do_not_email?: boolean;
};

type Channel = "call" | "sms" | "email" | "contract";

function isBlocked(customer: CustomerSearchOption, channel: Channel) {
  if (channel === "call") return customer.do_not_call === true;
  if (channel === "sms") return customer.do_not_sms === true;
  if (channel === "email") return customer.do_not_email === true;
  return false;
}

function detail(customer: CustomerSearchOption, channel: Channel) {
  if (channel === "email") return customer.email;
  if (channel === "sms" || channel === "call") return customer.phone_e164;
  return customer.organization_number || customer.email || customer.phone_e164;
}

export function CustomerSearchSelect({
  name,
  label = "Kund",
  channel = "contract",
  defaultValue = "",
  initialCustomer = null,
  required = false,
}: {
  name: string;
  label?: string;
  channel?: Channel;
  defaultValue?: string;
  initialCustomer?: CustomerSearchOption | null;
  required?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(defaultValue || initialCustomer?.id || "");
  const [results, setResults] = useState<CustomerSearchOption[]>(initialCustomer ? [initialCustomer] : []);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const normalizedQuery = query.trim();
        if (normalizedQuery.length === 1) {
          setResults(initialCustomer ? [initialCustomer] : []);
          return;
        }
        const url = new URL("/api/v1/customers", window.location.origin);
        url.searchParams.set("limit", "30");
        if (normalizedQuery) url.searchParams.set("q", normalizedQuery);
        const response = await fetch(url, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { data?: CustomerSearchOption[] };
        const next = payload.data ?? [];
        setResults(initialCustomer && !next.some((customer) => customer.id === initialCustomer.id)
          ? [initialCustomer, ...next]
          : next);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error("Customer search failed", error);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, initialCustomer]);

  const options = useMemo(() => {
    const byId = new Map<string, CustomerSearchOption>();
    for (const customer of results) byId.set(customer.id, customer);
    if (initialCustomer) byId.set(initialCustomer.id, initialCustomer);
    return [...byId.values()];
  }, [results, initialCustomer]);

  return <div className="form-stack" style={{ gap: 8 }}>
    <label className="field">
      <span>Sök {label.toLowerCase()}</span>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Namn, telefon, e-post eller organisationsnummer"
        autoComplete="off"
      />
      <small>{loading ? "Söker…" : "Visar högst 30 behöriga träffar"}</small>
    </label>
    <label className="field">
      <span>{label}</span>
      <select name={name} value={selected} onChange={(event) => setSelected(event.target.value)} required={required}>
        <option value="">Välj kund</option>
        {options.map((customer) => {
          const blocked = isBlocked(customer, channel);
          const suffix = detail(customer, channel);
          return <option key={customer.id} value={customer.id} disabled={blocked}>
            {customer.display_name}{suffix ? ` · ${suffix}` : ""}{blocked ? " · SPÄRRAD" : ""}
          </option>;
        })}
      </select>
    </label>
  </div>;
}
