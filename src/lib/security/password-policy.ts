import { z } from "zod";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordPolicyIssues,
} from "@/lib/security/password-policy-config";

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordPolicyHint, passwordPolicyIssues } from "@/lib/security/password-policy-config";

export const passwordSchema = z.string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .superRefine((password, context) => {
    for (const issue of passwordPolicyIssues(password)) {
      context.addIssue({ code: "custom", message: issue });
    }
  });
