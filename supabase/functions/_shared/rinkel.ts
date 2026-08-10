export const RINKEL_DEFAULT_BASE_URL = "https://api.rinkel.com/v1";
export const RINKEL_CORE_WEBHOOK_EVENTS = [
  "incomingCall",
  "outgoingCall",
  "callStart",
  "callEnd",
] as const;
export const RINKEL_OPTIONAL_WEBHOOK_EVENTS = ["callInsights"] as const;
export const RINKEL_WEBHOOK_EVENTS = [
  ...RINKEL_CORE_WEBHOOK_EVENTS,
  ...RINKEL_OPTIONAL_WEBHOOK_EVENTS,
] as const;

export type RinkelWebhookEvent = typeof RINKEL_WEBHOOK_EVENTS[number];
export type RinkelErrorCode =
  | "RINKEL_AUTHENTICATION_ERROR"
  | "RINKEL_FORBIDDEN"
  | "RINKEL_PLAN_UNSUPPORTED"
  | "RINKEL_INVALID_REQUEST"
  | "RINKEL_DEVICE_NOT_FOUND"
  | "RINKEL_NUMBER_NOT_FOUND"
  | "RINKEL_RATE_LIMITED"
  | "RINKEL_TIMEOUT"
  | "RINKEL_NETWORK_ERROR"
  | "RINKEL_UPSTREAM_ERROR"
  | "RINKEL_SCHEMA_ERROR"
  | "RINKEL_INVALID_RESPONSE"
  | "RINKEL_UNKNOWN_ERROR";

export class RinkelError extends Error {
  constructor(
    public readonly code: RinkelErrorCode,
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "RinkelError";
  }
}

type JsonObject = Record<string, unknown>;

export type RinkelDevice = {
  id: string;
  displayName: string | null;
  type: string | null;
  status: string;
  active: boolean;
  raw: JsonObject;
};

export type RinkelUser = {
  id: string;
  deviceId: string | null;
  devices: RinkelDevice[];
  email: string | null;
  fullName: string;
  active: boolean;
  raw: JsonObject;
};

export type RinkelNumber = {
  id: string;
  number: string;
  label: string | null;
  status: string;
  active: boolean;
  recordingEnabled: boolean;
  raw: JsonObject;
};

export type RinkelWebhookPayload =
  | { event: "incomingCall"; id: string; datetime: string; to: string; from: string }
  | { event: "outgoingCall"; id: string; datetime: string; to: string; from: string; userId: string }
  | { event: "callStart"; id: string; datetime: string; answeredBy: string | null; choice: string | null; userId: string | null }
  | { event: "callEnd"; id: string; datetime: string; cause: RinkelEndCause; knownCause: boolean; callRecordingUrl: string | null; voicemailUrl: string | null }
  | { event: "callInsights"; id: string; sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE"; topics: string[]; summary: string };

export type RinkelKnownEndCause =
  | "UNANSWERED"
  | "ANSWERED"
  | "BLACKLISTED"
  | "VOICEMAIL"
  | "CALLCENTER"
  | "OUTSIDE_OPERATION_TIMES";

/**
 * Rinkel can add new end causes without a coordinated Kundexa release. Keep
 * the raw, bounded provider value so the webhook remains ingestible and can be
 * reconciled later instead of returning 400 and losing the event.
 */
export type RinkelEndCause = string;

export type RinkelProviderOutcome =
  | "answered"
  | "no_answer"
  | "blocked"
  | "voicemail"
  | "answering_service"
  | "outside_business_hours"
  | "provider_error"
  | "unknown";

export type RinkelCallStatus =
  | "completed"
  | "unanswered"
  | "blocked"
  | "voicemail"
  | "outside_business_hours";

export type RinkelClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  requestId?: string;
  fetchImpl?: typeof fetch;
};

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: JsonObject;
  retrySafe?: boolean;
  acceptNoContent?: boolean;
};

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel returnerade ett oväntat svar.");
  }
  return value as JsonObject;
}

function string(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || !value) {
    throw new RinkelError("RINKEL_SCHEMA_ERROR", `Rinkel-fältet ${field} saknas.`);
  }
  return value;
}

function boolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RinkelError("RINKEL_SCHEMA_ERROR", `Rinkel-fältet ${field} är ogiltigt.`);
  }
  return value as string[];
}

function responseData(value: unknown): unknown {
  // Rinkel endpoints have historically returned both a direct payload and a
  // { data: ... } envelope. Accept both shapes, then validate the endpoint-
  // specific payload strictly in the caller.
  if (Array.isArray(value)) return value;
  const root = object(value);
  return "data" in root ? root.data : root;
}

function validDate(value: unknown, field: string): string {
  const result = string(value, field);
  if (!result || Number.isNaN(Date.parse(result))) {
    throw new RinkelError("RINKEL_SCHEMA_ERROR", `Rinkel-fältet ${field} är inte ett datum.`);
  }
  return result;
}

function validE164OrAnonymous(value: unknown, field: string): string {
  const result = string(value, field);
  if (!result || (result !== "anonymous" && !/^\+[1-9]\d{7,14}$/.test(result))) {
    throw new RinkelError("RINKEL_SCHEMA_ERROR", `Rinkel-fältet ${field} är inte E.164.`);
  }
  return result;
}

function safeProviderMessage(value: string) {
  return value
    .replace(/x-rinkel-api-key\s*[:=]\s*\S+/gi, "x-rinkel-api-key: [REDACTED]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]")
    .slice(0, 300);
}

function errorForStatus(status: number, path: string, providerText: string): RinkelError {
  const message = safeProviderMessage(providerText || `HTTP ${status}`);
  if (status === 400) return new RinkelError("RINKEL_INVALID_REQUEST", message, status);
  if (status === 401) return new RinkelError("RINKEL_AUTHENTICATION_ERROR", "Rinkel API-nyckeln nekades.", status);
  if (status === 403) {
    const plan = path.startsWith("/webhooks");
    return new RinkelError(plan ? "RINKEL_PLAN_UNSUPPORTED" : "RINKEL_FORBIDDEN", plan ? "Rinkel-kontot saknar stöd för webhookar." : "Rinkel nekade åtgärden.", status);
  }
  if (status === 404 && path === "/dial") {
    return new RinkelError("RINKEL_DEVICE_NOT_FOUND", "Rinkel-enheten eller numret kunde inte hittas.", status);
  }
  if (status === 404) return new RinkelError("RINKEL_NUMBER_NOT_FOUND", "Rinkel-resursen kunde inte hittas.", status);
  if (status === 429) return new RinkelError("RINKEL_RATE_LIMITED", "Rinkels anropsgräns är tillfälligt nådd.", status, true);
  if (status >= 500) return new RinkelError("RINKEL_UPSTREAM_ERROR", "Rinkel har ett tillfälligt serverfel.", status, true);
  return new RinkelError("RINKEL_UNKNOWN_ERROR", message, status);
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function delay(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class RinkelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly requestId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RinkelClientOptions) {
    if (!options.apiKey.trim()) throw new RinkelError("RINKEL_AUTHENTICATION_ERROR", "Rinkel API-nyckel saknas.");
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? RINKEL_DEFAULT_BASE_URL;
    this.timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 15000, 60000));
    this.requestId = options.requestId ?? crypto.randomUUID();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const method = options.method ?? "GET";
    const attempts = options.retrySafe && method === "GET" ? 3 : 1;
    let lastError: RinkelError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
          method,
          headers: {
            "x-rinkel-api-key": this.apiKey,
            "content-type": "application/json",
            "accept": "application/json",
            "x-request-id": this.requestId,
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        if (response.status === 204 && options.acceptNoContent) return null;
        const text = await response.text();
        if (!response.ok) throw errorForStatus(response.status, path, text);
        if (!text) return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel returnerade ogiltig JSON.", response.status);
        }
      } catch (error) {
        if (error instanceof RinkelError) lastError = error;
        else if (error instanceof DOMException && error.name === "AbortError") {
          lastError = new RinkelError(
            "RINKEL_TIMEOUT",
            "Rinkel svarade inte inom tidsgränsen.",
            null,
            method === "GET",
            method === "POST",
          );
        } else {
          lastError = new RinkelError(
            "RINKEL_NETWORK_ERROR",
            "Rinkel kunde inte nås.",
            null,
            method === "GET",
            method === "POST",
          );
        }
        if (attempt >= attempts || !lastError.retryable) throw lastError;
        await delay(200 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new RinkelError("RINKEL_UNKNOWN_ERROR", "Okänt Rinkel-fel.");
  }

  async listUsers(): Promise<RinkelUser[]> {
    const raw = await this.request("/users", { retrySafe: true });
    const data = responseData(raw);
    if (!Array.isArray(data)) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkels användarlista är ogiltig.");
    return data.map((entry) => normalizeRinkelUser(entry));
  }

  async listNumbers(): Promise<RinkelNumber[]> {
    const raw = await this.request("/numbers", { retrySafe: true });
    const data = responseData(raw);
    if (!Array.isArray(data)) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkels nummerlista är ogiltig.");
    return data.map((entry) => normalizeRinkelNumber(entry));
  }

  async dial(input: { deviceId: string; to: string; numberId: string; anonymous?: boolean }): Promise<void> {
    if (!input.deviceId || !input.numberId || !/^\+[1-9]\d{7,14}$/.test(input.to)) {
      throw new RinkelError("RINKEL_INVALID_REQUEST", "Rinkel dial-underlaget är ogiltigt.");
    }
    await this.request("/dial", {
      method: "POST",
      body: {
        deviceId: input.deviceId,
        to: input.to,
        numberId: input.numberId,
        anonymous: input.anonymous ?? false,
      },
      retrySafe: false,
      acceptNoContent: true,
    });
  }

  async listWebhooks(): Promise<Array<{ url: string; contentType: string; event: RinkelWebhookEvent; active: boolean; description: string | null }>> {
    const raw = await this.request("/webhooks", { retrySafe: true });
    const data = responseData(raw);
    if (!Array.isArray(data)) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkels webhooklista är ogiltig.");
    return data.flatMap((entry) => {
      const item = object(entry);
      const event = string(item.event, "event", true);
      // Rinkel can add webhook types independently of Kundexa releases. Ignore
      // unknown catalog entries while retaining known core/optional entries.
      if (!isRinkelWebhookEvent(event)) return [];
      return [{
        url: string(item.url, "url")!,
        contentType: string(item.contentType, "contentType")!,
        event,
        active: boolean(item.active),
        description: string(item.description, "description", true),
      }];
    });
  }

  async subscribeWebhook(
    event: RinkelWebhookEvent,
    input: { url: string; contentType?: "application/json" | "application/x-www-form-urlencoded"; active?: boolean; description?: string },
  ) {
    const raw = await this.request(`/webhooks/${event}`, {
      method: "POST",
      body: {
        url: input.url,
        contentType: input.contentType ?? "application/json",
        active: input.active ?? true,
        description: input.description ?? "Kundexa",
      },
    });
    return raw === null ? null : responseData(raw);
  }

  async updateWebhook(
    event: RinkelWebhookEvent,
    input: { url: string; contentType?: "application/json" | "application/x-www-form-urlencoded"; active?: boolean; description?: string },
  ) {
    const raw = await this.request(`/webhooks/${event}`, {
      method: "PUT",
      body: {
        url: input.url,
        contentType: input.contentType ?? "application/json",
        active: input.active ?? true,
        description: input.description ?? "Kundexa",
      },
    });
    return raw === null ? null : responseData(raw);
  }


  async getCallByCallId(callId: string, includeDetails = true): Promise<JsonObject | null> {
    try {
      const raw = await this.request(`/call-detail-records/by-call-id/${encodeURIComponent(callId)}?includeDetails=${includeDetails}`, { retrySafe: true });
      return object(responseData(raw));
    } catch (error) {
      if (error instanceof RinkelError && error.status === 404) return null;
      throw error;
    }
  }

  async listCallDetailRecordPage(query: {
    startDate: string;
    endDate: string;
    cursor?: string | null;
    page?: number;
    limit?: number;
  }): Promise<{ records: JsonObject[]; nextCursor: string | null; nextPage: number | null }> {
    const limit = Math.max(1, Math.min(query.limit ?? 250, 250));
    const params = new URLSearchParams({ startDate: query.startDate, endDate: query.endDate, limit: String(limit) });
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.page && query.page > 0) params.set("page", String(query.page));
    const raw = await this.request(`/call-detail-records?${params.toString()}`, { retrySafe: true });
    const data = responseData(raw);
    if (Array.isArray(data)) {
      return { records: data.map(object), nextCursor: null, nextPage: data.length === limit ? (query.page ?? 1) + 1 : null };
    }
    const container = object(data);
    const records = container.items ?? container.records ?? container.data;
    if (!Array.isArray(records)) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkels samtalslista är ogiltig.");
    const paging = container.pagination && typeof container.pagination === "object" && !Array.isArray(container.pagination)
      ? object(container.pagination)
      : container.meta && typeof container.meta === "object" && !Array.isArray(container.meta)
        ? object(container.meta)
        : container;
    const nextCursor = string(paging.nextCursor ?? paging.next_cursor ?? container.nextCursor ?? container.next_cursor, "nextCursor", true);
    const explicitNextPage = paging.nextPage ?? paging.next_page ?? container.nextPage ?? container.next_page;
    const nextPage = typeof explicitNextPage === "number" && Number.isInteger(explicitNextPage)
      ? explicitNextPage
      : nextCursor ? null : records.length === limit ? (query.page ?? 1) + 1 : null;
    return { records: records.map(object), nextCursor, nextPage };
  }

  async listCallDetailRecords(query: { startDate: string; endDate: string }): Promise<JsonObject[]> {
    const records: JsonObject[] = [];
    let cursor: string | null = null;
    let page: number | null = 1;
    const seenCursors = new Set<string>();
    for (let batch = 0; batch < 100; batch += 1) {
      const result = await this.listCallDetailRecordPage({
        startDate: query.startDate,
        endDate: query.endDate,
        cursor,
        page: cursor ? undefined : page ?? undefined,
      });
      records.push(...result.records);
      if (result.nextCursor) {
        if (seenCursors.has(result.nextCursor)) throw new RinkelError("RINKEL_INVALID_RESPONSE", "Rinkels CDR-pagination upprepade samma cursor.");
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
        page = null;
        continue;
      }
      if (result.nextPage) {
        page = result.nextPage;
        cursor = null;
        continue;
      }
      return records;
    }
    throw new RinkelError("RINKEL_INVALID_RESPONSE", "Rinkels CDR-pagination överskred säker batchgräns.");
  }

  async getTranscription(callId: string): Promise<{ available: boolean; value: unknown }> {
    const raw = await this.request(`/call-detail-records/by-call-id/${encodeURIComponent(callId)}/transcription`, {
      retrySafe: true,
      acceptNoContent: true,
    });
    return raw === null ? { available: false, value: null } : { available: true, value: responseData(raw) };
  }

  async getRecordingUrl(recordingId: string): Promise<string> {
    const raw = await this.request(`/call-recordings/${encodeURIComponent(recordingId)}/stream`, { retrySafe: true });
    const data = object(responseData(raw));
    const url = string(data.url, "data.url")!;
    assertRinkelTemporaryAudioUrl(url);
    return url;
  }

  async deleteCallRecording(recordingId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(recordingId)) {
      throw new RinkelError("RINKEL_INVALID_REQUEST", "Rinkel-inspelningens id är ogiltigt.");
    }
    try {
      await this.request(`/call-recordings/${encodeURIComponent(recordingId)}`, {
        method: "DELETE",
        acceptNoContent: true,
      });
    } catch (error) {
      // Retention is idempotent: an already deleted provider object is success.
      if (error instanceof RinkelError && error.status === 404) return;
      throw error;
    }
  }
}

function normalizeRinkelDevice(value: unknown, fallbackIndex: number): RinkelDevice {
  if (typeof value === "string" && value.trim()) {
    return { id: value.trim(), displayName: null, type: null, status: "unknown", active: true, raw: { id: value.trim() } };
  }
  const item = object(value);
  const id = string(item.id ?? item.deviceId, `devices[${fallbackIndex}].id`)!;
  const status = string(item.status, `devices[${fallbackIndex}].status`, true) ?? "unknown";
  return {
    id,
    displayName: string(item.displayName ?? item.name ?? item.label, `devices[${fallbackIndex}].displayName`, true),
    type: string(item.type ?? item.deviceType, `devices[${fallbackIndex}].type`, true),
    status,
    active: item.active === undefined ? !["inactive", "disabled", "removed"].includes(status.toLowerCase()) : boolean(item.active),
    raw: item,
  };
}

export function normalizeRinkelUser(value: unknown): RinkelUser {
  const item = object(value);
  const fullName = string(item.fullName ?? item.name ?? item.displayName, "fullName", true)
    ?? [string(item.firstName, "firstName", true), string(item.lastName, "lastName", true)].filter(Boolean).join(" ")
    ?? "";
  if (!fullName) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel-användaren saknar namn.");
  const legacyDeviceId = string(item.deviceId ?? item.defaultDeviceId, "deviceId", true);
  const rawDevices = Array.isArray(item.devices) ? item.devices : [];
  const devices = rawDevices.map((device, index) => normalizeRinkelDevice(device, index));
  if (legacyDeviceId && !devices.some((device) => device.id === legacyDeviceId)) {
    devices.unshift({
      id: legacyDeviceId,
      displayName: "Standardenhet",
      type: null,
      status: "unknown",
      active: true,
      raw: { id: legacyDeviceId, source: "legacy_deviceId" },
    });
  }
  return {
    id: string(item.id ?? item.userId, "id")!,
    deviceId: devices.find((device) => device.active)?.id ?? legacyDeviceId,
    devices,
    email: string(item.email, "email", true),
    fullName,
    active: item.active === undefined ? true : boolean(item.active),
    raw: item,
  };
}

export function normalizeRinkelNumber(value: unknown): RinkelNumber {
  const item = object(value);
  const number = string(item.number ?? item.phoneNumber ?? item.phone_number, "number")!;
  if (!/^\+[1-9]\d{7,14}$/.test(number)) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel-numret är inte E.164.");
  const status = string(item.status, "status", true) ?? "unknown";
  const normalizedStatus = status.toLowerCase();
  const inactiveStatuses = ["inactive", "disabled", "cancelled", "canceled", "removed", "archived"];
  const active = typeof item.active === "boolean"
    ? item.active
    : !inactiveStatuses.includes(normalizedStatus);
  const recording = item.recording && typeof item.recording === "object" ? object(item.recording) : null;
  return {
    id: string(item.id ?? item.numberId, "id")!,
    number,
    label: string(item.label ?? item.name ?? item.displayName, "label", true),
    status,
    active,
    recordingEnabled: recording ? boolean(recording.enabled) : boolean(item.recordingEnabled),
    raw: item,
  };
}

export function isRinkelWebhookEvent(value: unknown): value is RinkelWebhookEvent {
  return typeof value === "string" && (RINKEL_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

export function parseRinkelWebhookPayload(event: RinkelWebhookEvent, value: unknown): RinkelWebhookPayload {
  const item = object(value);
  const id = string(item.id, "id")!;
  if (event === "incomingCall") {
    return {
      event,
      id,
      datetime: validDate(item.datetime, "datetime"),
      to: validE164OrAnonymous(item.to, "to"),
      from: validE164OrAnonymous(item.from, "from"),
    };
  }
  if (event === "outgoingCall") {
    return {
      event,
      id,
      datetime: validDate(item.datetime, "datetime"),
      to: validE164OrAnonymous(item.to, "to"),
      from: validE164OrAnonymous(item.from, "from"),
      userId: string(item.userId, "userId")!,
    };
  }
  if (event === "callStart") {
    return {
      event,
      id,
      datetime: validDate(item.datetime, "datetime"),
      answeredBy: string(item.answeredBy, "answeredBy", true),
      choice: string(item.choice, "choice", true),
      userId: string(item.userId, "userId", true),
    };
  }
  if (event === "callEnd") {
    const cause = string(item.cause, "cause");
    if (!isRinkelEndCause(cause)) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel callEnd-cause har ogiltigt format.");
    const recordingUrl = string(item.callRecordingUrl, "callRecordingUrl", true);
    if (recordingUrl) assertRinkelRecordingReference(recordingUrl);
    const voicemailUrl = string(item.voicemailUrl, "voicemailUrl", true);
    return {
      event,
      id,
      datetime: validDate(item.datetime, "datetime"),
      cause,
      knownCause: isKnownRinkelEndCause(cause),
      callRecordingUrl: recordingUrl,
      voicemailUrl,
    };
  }
  const sentiment = string(item.sentiment, "sentiment");
  if (!["POSITIVE", "NEUTRAL", "NEGATIVE"].includes(sentiment ?? "")) {
    throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel sentiment är ogiltigt.");
  }
  const topics = stringArray(item.topics, "topics");
  if (topics.length > 4) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel topics innehåller för många värden.");
  return {
    event,
    id,
    sentiment: sentiment as "POSITIVE" | "NEUTRAL" | "NEGATIVE",
    topics,
    summary: string(item.summary, "summary")!,
  };
}

export function isRinkelEndCause(value: unknown): value is RinkelEndCause {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value);
}

export function isKnownRinkelEndCause(value: unknown): value is RinkelKnownEndCause {
  return typeof value === "string" && [
    "UNANSWERED",
    "ANSWERED",
    "BLACKLISTED",
    "VOICEMAIL",
    "CALLCENTER",
    "OUTSIDE_OPERATION_TIMES",
  ].includes(value);
}

export function mapRinkelCause(cause: RinkelEndCause): RinkelProviderOutcome {
  if (cause === "ANSWERED") return "answered";
  if (cause === "CALLCENTER") return "answering_service";
  if (cause === "UNANSWERED") return "no_answer";
  if (cause === "BLACKLISTED") return "blocked";
  if (cause === "VOICEMAIL") return "voicemail";
  if (cause === "OUTSIDE_OPERATION_TIMES") return "outside_business_hours";
  return "unknown";
}

export function mapRinkelCauseToCallStatus(cause: RinkelEndCause): RinkelCallStatus {
  const outcome = mapRinkelCause(cause);
  if (outcome === "no_answer") return "unanswered";
  if (outcome === "blocked") return "blocked";
  if (outcome === "voicemail") return "voicemail";
  if (outcome === "outside_business_hours") return "outside_business_hours";
  return "completed";
}

export function isTerminalCallStatus(status: string) {
  return [
    "completed",
    "unanswered",
    "failed",
    "blocked",
    "voicemail",
    "outside_business_hours",
    "cancelled",
    "busy",
    "no_answer",
  ].includes(status);
}

export function maskPhone(value: string) {
  if (value === "anonymous") return value;
  if (value.length < 8) return "****";
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 7))}${value.slice(-3)}`;
}

export function extractRinkelRecordingId(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "api.rinkel.com") {
    throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel-inspelningsreferensen har fel värd.");
  }
  // Rinkel webhook examples omit /v1 while API responses may include it.
  const match = /^\/(?:v1\/)?call-recordings\/([A-Za-z0-9_-]+)\/stream\/?$/.exec(url.pathname);
  if (!match) throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel-inspelningsreferensen har fel sökväg.");
  return match[1];
}

export function assertRinkelRecordingReference(value: string) {
  extractRinkelRecordingId(value);
}

export function assertRinkelTemporaryAudioUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "api.rinkel.com") {
    throw new RinkelError("RINKEL_SCHEMA_ERROR", "Rinkel-ljudlänken har fel värd.");
  }
}

export function safeRinkelError(error: unknown): { code: RinkelErrorCode; message: string; retryable: boolean; outcomeUnknown: boolean } {
  if (error instanceof RinkelError) {
    return { code: error.code, message: error.message, retryable: error.retryable, outcomeUnknown: error.outcomeUnknown };
  }
  return {
    code: "RINKEL_UNKNOWN_ERROR",
    message: "Ett oväntat Rinkel-fel inträffade.",
    retryable: false,
    outcomeUnknown: false,
  };
}
