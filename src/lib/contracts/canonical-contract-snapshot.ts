import { hashContractSnapshot } from "@/lib/contracts/document-hash";

export type CanonicalContractSnapshot = {
  schema_version: 1;
  contract: {
    id: string;
    number: string;
    title: string;
    audience: string;
    sales_channel: string;
    starts_on: string | null;
    ends_on: string | null;
    binding_months: number | null;
    notice_months: number | null;
    value: number;
    currency: string;
    created_at: string;
  };
  version: {
    id: string;
    number: number;
    title: string;
    body: string;
    terms: string;
    commercial_terms: Record<string, unknown>;
    template_version_id: string | null;
    price_version_id: string | null;
  };
  seller: Record<string, unknown>;
  counterparty: Record<string, unknown>;
  source_call: {
    id: string;
    ended_at: string;
    disposition: string;
    seller_user_id: string | null;
  };
  generated_at: string;
};

type ContractInput = {
  id: string;
  contract_number: string;
  title: string;
  audience: string;
  sales_channel: string;
  starts_on: string | null;
  ends_on: string | null;
  binding_months: number | null;
  notice_months: number | null;
  value: number;
  currency: string;
  created_at: string;
  seller_snapshot: Record<string, unknown> | null;
  counterparty_snapshot: Record<string, unknown> | null;
};

type VersionInput = {
  id: string;
  version: number;
  title: string;
  rendered_body: string;
  rendered_terms: string | null;
  commercial_terms: Record<string, unknown> | null;
  template_version_id: string | null;
  price_version_id: string | null;
  created_at: string;
};

type CallInput = { id: string; ended_at: string; disposition: string; user_id: string | null };

export function createCanonicalContractSnapshot(contract: ContractInput, version: VersionInput, call: CallInput) {
  const snapshot: CanonicalContractSnapshot = {
    schema_version: 1,
    contract: {
      id: contract.id,
      number: contract.contract_number,
      title: contract.title,
      audience: contract.audience,
      sales_channel: contract.sales_channel,
      starts_on: contract.starts_on,
      ends_on: contract.ends_on,
      binding_months: contract.binding_months,
      notice_months: contract.notice_months,
      value: Number(contract.value),
      currency: contract.currency,
      created_at: contract.created_at,
    },
    version: {
      id: version.id,
      number: version.version,
      title: version.title,
      body: version.rendered_body,
      terms: version.rendered_terms ?? "",
      commercial_terms: version.commercial_terms ?? {},
      template_version_id: version.template_version_id,
      price_version_id: version.price_version_id,
    },
    seller: contract.seller_snapshot ?? {},
    counterparty: contract.counterparty_snapshot ?? {},
    source_call: {
      id: call.id,
      ended_at: call.ended_at,
      disposition: call.disposition,
      seller_user_id: call.user_id,
    },
    generated_at: version.created_at,
  };
  return { snapshot, snapshotHash: hashContractSnapshot(snapshot) };
}
