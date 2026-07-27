import { sha256, sha256Bytes } from "@/lib/crypto";

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function hashContractSnapshot(value: unknown) {
  return sha256(stableJson(value));
}

export function hashPdfBytes(value: Uint8Array) {
  return sha256Bytes(value);
}
