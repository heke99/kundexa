export type IdentityAssuranceLevel = "low" | "substantial" | "high";
export type SignatureMethod = "simple_click" | "email_otp" | "sms_otp" | "bankid" | "external_esign";

export type SignaturePolicy = {
  method: SignatureMethod;
  identityAssuranceLevel: IdentityAssuranceLevel;
  orderedSigning?: boolean;
  requireFinalProviderDocument?: boolean;
};

export type SigningRecipientInput = {
  recipientId: string;
  fullName: string;
  email?: string | null;
  phoneE164?: string | null;
  role: string;
  required: boolean;
  signingOrder: number;
};

export type CreateEnvelopeInput = {
  tenantId: string;
  contractId: string;
  contractVersionId: string;
  sourceDocumentId: string;
  idempotencyKey: string;
  policy: SignaturePolicy;
  recipients: SigningRecipientInput[];
  callbackUrl: string;
};

export type CreateEnvelopeResult = {
  providerEnvelopeId: string;
  status: "draft" | "sent";
  recipients: Array<{ recipientId: string; providerRecipientId: string }>;
};

export type SignerSessionInput = {
  providerEnvelopeId: string;
  providerRecipientId: string;
  returnUrl: string;
  idempotencyKey: string;
};

export type SignerSessionResult = {
  url: string;
  expiresAt: string;
  providerTransactionId?: string;
};

export type ProviderEnvelope = {
  providerEnvelopeId: string;
  status: "draft" | "sent" | "partially_signed" | "completed" | "declined" | "expired" | "cancelled" | "failed";
  completedAt?: string | null;
  evidence?: Record<string, unknown>;
};

export type VerifiedSigningEvent = {
  providerEventId: string;
  providerEnvelopeId: string;
  providerRecipientId?: string | null;
  eventType: string;
  eventAt: string;
  verified: true;
  payload: Record<string, unknown>;
};

export interface SigningProvider {
  readonly name: string;
  createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult>;
  createSignerSession(input: SignerSessionInput): Promise<SignerSessionResult>;
  cancelEnvelope(providerEnvelopeId: string): Promise<void>;
  fetchEnvelope(providerEnvelopeId: string): Promise<ProviderEnvelope>;
  fetchFinalDocument(providerEnvelopeId: string): Promise<Uint8Array>;
  verifyWebhook(rawBody: Uint8Array, headers: Headers): VerifiedSigningEvent;
}

const providers = new Map<string, SigningProvider>();

export function registerSigningProvider(provider: SigningProvider) {
  if (!provider.name.trim()) throw new Error("signing_provider_name_required");
  if (providers.has(provider.name)) throw new Error(`signing_provider_already_registered:${provider.name}`);
  providers.set(provider.name, provider);
}

export function getSigningProvider(name: string) {
  const provider = providers.get(name);
  if (!provider) throw new Error(`signing_provider_not_configured:${name}`);
  return provider;
}
