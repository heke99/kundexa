import type { Json } from "@/lib/supabase/database.types";

export type JsonObject = { [key: string]: Json | undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => entry === undefined || isJsonValue(entry));
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every((entry) => entry === undefined || isJsonValue(entry));
}

export function readJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

/**
 * Convert an application value into the exact JSON value accepted by Supabase.
 * Undefined object properties are omitted. Unsupported values, non-finite numbers,
 * class instances and cyclic structures fail fast instead of corrupting metadata.
 */
export function toJson(value: unknown): Json {
  const visited = new WeakSet<object>();

  function convert(entry: unknown): Json {
    if (entry === null) return null;
    if (typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new TypeError("Non-finite numbers cannot be stored as JSON");
      return entry;
    }
    if (entry instanceof Date) return entry.toISOString();
    if (Array.isArray(entry)) {
      if (visited.has(entry)) throw new TypeError("Cyclic structures cannot be stored as JSON");
      visited.add(entry);
      const converted = entry.map((item) => convert(item));
      visited.delete(entry);
      return converted;
    }
    if (isRecord(entry)) {
      if (visited.has(entry)) throw new TypeError("Cyclic structures cannot be stored as JSON");
      visited.add(entry);
      const output: JsonObject = {};
      for (const [key, item] of Object.entries(entry)) {
        if (item !== undefined) output[key] = convert(item);
      }
      visited.delete(entry);
      return output;
    }
    throw new TypeError(`Unsupported JSON value: ${typeof entry}`);
  }

  return convert(value);
}

export function toJsonObject(value: unknown): JsonObject {
  const converted = toJson(value);
  if (!isJsonObject(converted)) throw new TypeError("Expected a JSON object");
  return converted;
}
