export type Permission =
  | "customers.read" | "customers.write" | "customers.export" | "imports.manage"
  | "campaigns.manage" | "products.manage"
  | "calls.read" | "calls.create" | "recordings.read"
  | "messages.read" | "messages.send"
  | "contracts.read" | "contracts.write" | "contracts.send"
  | "automations.manage" | "users.manage" | "settings.manage" | "reports.read";

const rolePermissions: Record<string, Permission[]> = {
  owner: ["customers.read", "customers.write", "customers.export", "imports.manage", "campaigns.manage", "products.manage", "calls.read", "calls.create", "recordings.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "automations.manage", "users.manage", "settings.manage", "reports.read"],
  admin: ["customers.read", "customers.write", "customers.export", "imports.manage", "campaigns.manage", "products.manage", "calls.read", "calls.create", "recordings.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "automations.manage", "users.manage", "settings.manage", "reports.read"],
  team_lead: ["customers.read", "customers.write", "imports.manage", "campaigns.manage", "calls.read", "calls.create", "recordings.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "reports.read"],
  sales: ["customers.read", "customers.write", "calls.read", "calls.create", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send"],
  contract_manager: ["customers.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "reports.read"],
  quality: ["customers.read", "calls.read", "recordings.read", "contracts.read", "reports.read"],
  backoffice: ["customers.read", "customers.write", "imports.manage", "messages.read", "messages.send", "contracts.read", "contracts.write"],
  finance: ["customers.read", "contracts.read", "reports.read"],
  viewer: ["customers.read", "calls.read", "messages.read", "contracts.read", "reports.read"],
};

export function can(role: string, permission: Permission) {
  return rolePermissions[role]?.includes(permission) ?? false;
}

export function assertPermission(role: string, permission: Permission) {
  if (!can(role, permission)) throw new Error(`permission_denied:${permission}`);
}

export const apiScopePermission: Record<string, Permission> = {
  "customers:read": "customers.read",
  "customers:write": "customers.write",
  "contracts:read": "contracts.read",
  "contracts:write": "contracts.write",
  "calls:create": "calls.create",
  "messages:send": "messages.send",
  "imports:write": "imports.manage",
  "reports:read": "reports.read",
};
