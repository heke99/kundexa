export type OrganizationNumberKind = "company" | "person" | "unknown";
export type OrganizationNumberErrorCode =
  | "empty"
  | "invalid_characters"
  | "invalid_length"
  | "invalid_luhn"
  | "person_number_not_allowed";

export type OrganizationNumberResult = {
  original: string;
  canonical: string | null;
  display: string | null;
  kind: OrganizationNumberKind;
  valid: boolean;
  errorCode: OrganizationNumberErrorCode | null;
};

export function passesLuhn(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const sum = value.split("").reduce((total, digit, index) => {
    const product = Number(digit) * (index % 2 === 0 ? 2 : 1);
    return total + Math.floor(product / 10) + (product % 10);
  }, 0);
  return sum % 10 === 0;
}

export function classifySwedishIdentityNumber(value: string): OrganizationNumberKind {
  if (!/^\d{10}$/.test(value)) return "unknown";
  const monthOrOrganizationMarker = Number(value.slice(2, 4));
  return monthOrOrganizationMarker >= 20 ? "company" : "person";
}

export function normalizeOrganizationNumber(
  input: string,
  options: { allowPerson?: boolean } = {},
): OrganizationNumberResult {
  const original = input;
  let value = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!value) return { original, canonical: null, display: null, kind: "unknown", valid: false, errorCode: "empty" };

  if (/^SE\d{12}$/.test(value) && value.endsWith("01")) value = value.slice(2, -2);
  else if (value.startsWith("SE")) value = value.slice(2);

  if (!/^\d+$/.test(value)) return { original, canonical: null, display: null, kind: "unknown", valid: false, errorCode: "invalid_characters" };
  if (value.length === 12 && value.startsWith("16")) value = value.slice(2);
  if (value.length !== 10) return { original, canonical: null, display: null, kind: "unknown", valid: false, errorCode: "invalid_length" };

  const kind = classifySwedishIdentityNumber(value);
  if (!passesLuhn(value)) return { original, canonical: null, display: null, kind, valid: false, errorCode: "invalid_luhn" };
  if (kind === "person" && !options.allowPerson) {
    return { original, canonical: null, display: null, kind, valid: false, errorCode: "person_number_not_allowed" };
  }
  return {
    original,
    canonical: value,
    display: `${value.slice(0, 6)}-${value.slice(6)}`,
    kind,
    valid: true,
    errorCode: null,
  };
}
