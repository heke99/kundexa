import { z } from "zod";
import type { SignaturePolicy } from "./provider";

export const signaturePolicySchema = z.object({
  method: z.enum(["simple_click", "email_otp", "sms_otp", "bankid", "external_esign"]),
  identityAssuranceLevel: z.enum(["low", "substantial", "high"]),
  orderedSigning: z.boolean().default(false),
  requireFinalProviderDocument: z.boolean().default(true),
}).superRefine((policy, context) => {
  if (policy.method === "simple_click" && policy.identityAssuranceLevel !== "low") {
    context.addIssue({ code: "custom", path: ["identityAssuranceLevel"], message: "Enkel webbacceptans får endast klassificeras som låg identitetsnivå." });
  }
  if (["bankid", "external_esign"].includes(policy.method) && !policy.requireFinalProviderDocument) {
    context.addIssue({ code: "custom", path: ["requireFinalProviderDocument"], message: "Verifierad signering kräver ett slutligt providerdokument." });
  }
});

export function parseSignaturePolicy(value: unknown): SignaturePolicy {
  return signaturePolicySchema.parse(value);
}
