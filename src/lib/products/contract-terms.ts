import { z } from "zod";

/** Empty is undecided. Explicit zero is a real per-product commercial value. */
export const nullableMonths = (maximum: number) => z.preprocess(
  value => value === "" || value === undefined || value === null ? null : value,
  z.coerce.number().int().min(0).max(maximum).nullable(),
);
export const productContractTermsSchema = z.object({
  bindingMonths: nullableMonths(240),
  noticeMonths: nullableMonths(120),
  paymentTermsDays: z.coerce.number().int().min(0).max(365),
});
