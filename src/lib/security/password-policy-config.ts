export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  "password1234",
  "password123!",
  "kundexa12345",
  "qwerty123456",
  "123456789012",
  "letmein123456",
]);

export function passwordPolicyIssues(password: string) {
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push(`minst ${PASSWORD_MIN_LENGTH} tecken`);
  if (password.length > PASSWORD_MAX_LENGTH) issues.push(`högst ${PASSWORD_MAX_LENGTH} tecken`);
  if (!/[a-zåäö]/.test(password)) issues.push("minst en liten bokstav");
  if (!/[A-ZÅÄÖ]/.test(password)) issues.push("minst en stor bokstav");
  if (!/\d/.test(password)) issues.push("minst en siffra");
  if (!/[^A-Za-zÅÄÖåäö0-9]/.test(password)) issues.push("minst ett specialtecken");
  if (COMMON_PASSWORDS.has(password.toLowerCase())) issues.push("ett mindre vanligt lösenord");
  return issues;
}

export function passwordPolicyHint() {
  return `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} tecken, stor och liten bokstav, siffra och specialtecken.`;
}
