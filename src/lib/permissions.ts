export type Permission =
  | "customers.read" | "customers.write" | "customers.export" | "imports.manage"
  | "campaigns.manage" | "lists.manage" | "products.manage"
  | "calls.read" | "calls.create" | "recordings.read"
  | "messages.read" | "messages.send"
  | "contracts.read" | "contracts.write" | "contracts.send" | "contracts.remind" | "contracts.manage_expiry" | "contracts.activate" | "contracts.manage_templates"
  | "integrations.manage" | "integrations.test"
  | "automations.manage" | "callbacks.create" | "orders.read" | "users.manage" | "settings.manage" | "reports.read"
  | "directory.read" | "directory.refresh" | "segments.manage" | "providers.manage";

const rolePermissions: Record<string, Permission[]> = {
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

export type RouteAccessRule = {
  roles?: string[];
  anyPermission?: Permission[];
};

/**
 * Canonical tenant navigation/route policy. Server layout and sidebar both use
 * this map; actions/API/RPC still enforce their own object-level permissions.
 */
export const routeAccessMap: Record<string, RouteAccessRule> = {
  "/app": { roles: ["owner", "admin", "team_lead", "sales", "contract_manager", "quality", "backoffice", "finance", "viewer"] },
  "/app/dialer": { anyPermission: ["calls.create"] },
  "/app/callbacks": { anyPermission: ["callbacks.create"] },
  "/app/calls": { anyPermission: ["calls.read"] },
  "/app/activities": { anyPermission: ["customers.read"] },
  "/app/calendar": { anyPermission: ["callbacks.create", "customers.read"] },
  "/app/customers": { anyPermission: ["customers.read"] },
  "/app/companies": { anyPermission: ["customers.read"] },
  "/app/directory": { anyPermission: ["directory.read"] },
  "/app/prospects": { anyPermission: ["customers.read"] },
  "/app/lists": { roles: ["owner", "admin", "team_lead", "sales"] },
  "/app/imports": { anyPermission: ["imports.manage"] },
  "/app/campaigns": { anyPermission: ["campaigns.manage"] },
  "/app/pipeline": { anyPermission: ["customers.read"] },
  "/app/orders": { anyPermission: ["orders.read"] },
  "/app/contracts": { anyPermission: ["contracts.read"] },
  "/app/documents": { anyPermission: ["contracts.read"] },
  "/app/templates": { anyPermission: ["contracts.manage_templates"] },
  "/app/products": { anyPermission: ["products.manage"] },
  "/app/sms": { anyPermission: ["messages.read", "messages.send"] },
  "/app/email": { anyPermission: ["messages.read", "messages.send"] },
  "/app/automations": { anyPermission: ["automations.manage"] },
  "/app/teams": { roles: ["owner", "admin", "team_lead"] },
  "/app/users": { roles: ["owner", "admin", "team_lead"] },
  "/app/reports": { anyPermission: ["reports.read"] },
  "/app/integrations": { anyPermission: ["integrations.manage"] },
  "/app/api": { roles: ["owner", "admin"] },
  "/app/webhooks": { roles: ["owner", "admin"] },
  "/app/compliance": { roles: ["owner", "admin", "backoffice", "quality"] },
  "/app/security": { roles: ["owner", "admin"] },
  "/app/admin": { roles: ["owner", "admin"] },
  "/app/billing": { roles: ["owner", "admin", "finance"] },
  "/app/data-sources": { roles: ["owner", "admin", "backoffice"] },
};

export type ResourceName = "customer" | "list" | "call" | "recording" | "contract" | "team" | "integration" | "report";
export type ResourcePermissionRule = { read?: Permission; write?: Permission; roles?: string[] };

export const resourcePermissionMap: Record<ResourceName, ResourcePermissionRule> = {
  customer: { read: "customers.read", write: "customers.write" },
  list: { read: "customers.read", write: "lists.manage", roles: ["owner", "admin", "team_lead", "sales"] },
  call: { read: "calls.read", write: "calls.create" },
  recording: { read: "recordings.read" },
  contract: { read: "contracts.read", write: "contracts.write" },
  team: { roles: ["owner", "admin", "team_lead"] },
  integration: { read: "integrations.manage", write: "integrations.manage" },
  report: { read: "reports.read" },
};

export function resolveRouteAccess(pathname: string): RouteAccessRule | null {
  const entries = Object.entries(routeAccessMap).sort(([a], [b]) => b.length - a.length);
  return entries.find(([route]) => route === "/app" ? pathname === route : pathname === route || pathname.startsWith(`${route}/`))?.[1] ?? null;
}

export function canAccessRoute(role: string, pathname: string) {
  const rule = resolveRouteAccess(pathname);
  if (!rule) return false;
  if (rule.roles?.includes(role)) return true;
  return rule.anyPermission?.some((permission) => can(role, permission)) ?? false;
}

