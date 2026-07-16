import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhone(value: string, defaultCountry: "SE" | "NO" | "DK" | "FI" = "SE") {
  const parsed = parsePhoneNumberFromString(value.trim(), defaultCountry);
  if (!parsed?.isValid()) throw new Error("Ogiltigt telefonnummer");
  return parsed.number;
}
