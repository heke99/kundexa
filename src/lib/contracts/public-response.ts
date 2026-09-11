import { z } from "zod";

// The customer's answer on the public acceptance page, parsed in one place so it
// can be tested. It lives outside the server action because a "use server"
// module may only export async functions.
//
// The decision has no default on purpose. It arrives as the value of the button
// the customer pressed; if it does not arrive, the only safe answer is to ask
// again. Treating a missing value as "accept" would record a legally binding
// acceptance because a form field went astray.
export const publicContractResponseSchema = z.object({
  fullName: z.string().min(2).max(200),
  confirm: z.literal("on"),
  decision: z.enum(["accept", "decline"]),
  acceptanceCode: z.string().trim().max(32).optional(),
});

export type PublicContractResponse = z.infer<typeof publicContractResponseSchema>;

/** Read the response from anything shaped like FormData. */
export function parsePublicContractResponse(form: { get(name: string): unknown }) {
  return publicContractResponseSchema.safeParse({
    fullName: String(form.get("full_name") ?? "").trim(),
    confirm: form.get("confirm"),
    decision: String(form.get("decision") ?? ""),
    acceptanceCode: String(form.get("acceptance_code") ?? "").trim() || undefined,
  });
}
