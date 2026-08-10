export type Permission =
  | "customers.read" | "customers.write" | "customers.export" | "imports.manage"
  | "campaigns.manage" | "lists.manage" | "products.manage"
  | "calls.read" | "calls.create" | "recordings.read"
  | "messages.read" | "messages.send"
  | "contracts.read" | "contracts.write" | "contracts.send" | "contracts.remind" | "contracts.manage_expiry" | "contracts.activate" | "contracts.manage_templates"
  | "integrations.manage" | "integrations.test"
  | "automations.manage" | "callbacks.create" | "orders.read" | "users.manage" | "settings.manage" | "reports.read"
  | "directory.read" | "directory.refresh" | "segments.manage" | "providers.manage";

export const rolePermissions: Readonly<Record<string, readonly Permission[]>> = {
  owner: ["customers.read", "customers.write", "customers.export", "imports.manage", "campaigns.manage", "lists.manage", "products.manage", "calls.read", "calls.create", "recordings.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "contracts.remind", "contracts.manage_expiry", "contracts.activate", "contracts.manage_templates", "integrations.manage", "integrations.test", "automations.manage", "callbacks.create", "orders.read", "users.manage", "settings.manage", "reports.read", "directory.read", "directory.refresh", "segments.manage", "providers.manage"],
  admin: ["customers.read", "customers.write", "customers.export", "imports.manage", "campaigns.manage", "lists.manage", "products.manage", "calls.read", "calls.create", "recordings.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "contracts.remind", "contracts.manage_expiry", "contracts.activate", "contracts.manage_templates", "integrations.manage", "integrations.test", "automations.manage", "callbacks.create", "orders.read", "users.manage", "settings.manage", "reports.read", "directory.read", "directory.refresh", "segments.manage", "providers.manage"],
  team_lead: ["customers.read", "customers.write", "imports.manage", "campaigns.manage", "lists.manage", "calls.read", "calls.create", "recordings.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "contracts.remind", "contracts.manage_expiry", "callbacks.create", "orders.read", "reports.read", "directory.read", "directory.refresh", "segments.manage"],
  sales: ["customers.read", "customers.write", "calls.read", "calls.create", "recordings.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "contracts.remind", "callbacks.create", "orders.read", "directory.read"],
  contract_manager: ["customers.read", "messages.read", "messages.send", "contracts.read", "contracts.write", "contracts.send", "contracts.remind", "contracts.manage_expiry", "contracts.activate", "contracts.manage_templates", "reports.read", "directory.read"],
  quality: ["customers.read", "calls.read", "recordings.read", "contracts.read", "reports.read"],
  backoffice: ["customers.read", "customers.write", "imports.manage", "messages.read", "messages.send", "contracts.read", "contracts.write", "callbacks.create", "orders.read", "directory.read", "directory.refresh", "segments.manage", "providers.manage"],
  finance: ["customers.read", "contracts.read", "reports.read"],
  viewer: ["customers.read", "calls.read", "messages.read", "contracts.read", "reports.read", "directory.read"],
};

/**
 * Canonical application-route policy. Navigation may consume this map to decide
 * visibility, but every server action/API/RPC must still enforce its own permission
 * and object scope. Longest matching path wins so nested routes inherit policy.
 */
export const routeAccessMap = {
  "/app": "customers.read",
  "/app/customers": "customers.read",
  "/app/prospects": "customers.read",
  "/app/dialer": "calls.create",
  "/app/calls": "calls.read",
  "/app/lists": "lists.manage",
  "/app/callbacks": "callbacks.create",
  "/app/contracts": "contracts.read",
  "/app/contracts/templates": "contracts.manage_templates",
  "/app/orders": "orders.read",
  "/app/reports": "reports.read",
  "/app/directory": "directory.read",
  "/app/segments": "segments.manage",
  "/app/users": "users.manage",
  "/app/teams": "users.manage",
  "/app/settings": "settings.manage",
  "/app/settings/integrations": "integrations.manage",
  "/app/settings/providers": "providers.manage",
} as const satisfies Readonly<Record<string, Permission>>;

/** Canonical coarse resource policy. Object/team/owner scope is applied separately. */
export const resourcePermissionMap = {
  customer: { read: "customers.read", write: "customers.write" },
  customer_list: { read: "customers.read", write: "lists.manage" },
  call: { read: "calls.read", write: "calls.create" },
  recording: { read: "recordings.read" },
  contract: { read: "contracts.read", write: "contracts.write" },
  contract_template: { read: "contracts.read", write: "contracts.manage_templates" },
  message: { read: "messages.read", write: "messages.send" },
  order: { read: "orders.read" },
  user: { read: "users.manage", write: "users.manage" },
  team: { read: "users.manage", write: "users.manage" },
  integration: { read: "integrations.manage", write: "integrations.manage" },
  provider: { read: "providers.manage", write: "providers.manage" },
  report: { read: "reports.read" },
} as const satisfies Readonly<Record<string, Readonly<Record<string, Permission>>>>;

export function can(role: string, permission: Permission) {
  return rolePermissions[role]?.includes(permission) ?? false;
}

export function assertPermission(role: string, permission: Permission) {
  if (!can(role, permission)) throw new Error(`permission_denied:${permission}`);
}

export function permissionForRoute(pathname: string): Permission | null {
  const matches = Object.keys(routeAccessMap)
    .filter((route) => pathname === route || pathname.startsWith(`${route}/`))
    .sort((a, b) => b.length - a.length);
  return matches.length ? routeAccessMap[matches[0] as keyof typeof routeAccessMap] : null;
}

export function canAccessRoute(role: string, pathname: string) {
  const permission = permissionForRoute(pathname);
  return permission ? can(role, permission) : true;
}

export const apiScopePermission: Record<string, Permission> = {
  "customers:read": "customers.read",
  "customers:write": "customers.write",
  "contracts:read": "contracts.read",
  "contracts:write": "contracts.write",
  "contracts:send": "contracts.send",
  "contracts:remind": "contracts.remind",
  "contracts:manage_expiry": "contracts.manage_expiry",
  "integrations:manage": "integrations.manage",
  "integrations:test": "integrations.test",
  "calls:create": "calls.create",
  "messages:send": "messages.send",
  "imports:write": "imports.manage",
  "reports:read": "reports.read",
  "directory:read": "directory.read",
  "directory:refresh": "directory.refresh",
  "segments:write": "segments.manage",
  "providers:manage": "providers.manage",
};
