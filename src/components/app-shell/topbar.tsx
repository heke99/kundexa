import { Bell, Search } from "@/components/icons";
import { initials } from "@/lib/utils";
import { signOut } from "@/app/actions/auth";
import { switchTenant } from "@/app/actions/organization";

type TenantOption = { tenant_id: string; tenant_name: string; membership_role: string; is_active: boolean };

export function Topbar({ tenantName, email, notificationCount = 0, tenants = [] }: { tenantName: string; email: string; notificationCount?: number; tenants?: TenantOption[] }) {
  return <header className="topbar"><div className="global-search"><Search size={17} /><input aria-label="Global sökning" placeholder="Sök kund, företag, avtal eller nummer…" /></div><div className="topbar-actions"><a className="icon-button notification-button" aria-label={`${notificationCount} förfallna återkomster`} href="/app/callbacks"><Bell size={19} />{notificationCount ? <span>{notificationCount > 99 ? "99+" : notificationCount}</span> : null}</a>{tenants.length > 1 ? <form action={switchTenant} style={{ display: "flex", gap: 6, alignItems: "center" }}><select name="tenant_id" defaultValue={tenants.find((tenant) => tenant.is_active)?.tenant_id} aria-label="Aktiv tenant" style={{ maxWidth: 190, border: "1px solid #d5dfe1", borderRadius: 9, padding: "8px 9px", background: "white" }}>{tenants.map((tenant) => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.tenant_name} · {tenant.membership_role}</option>)}</select><button className="button button-secondary button-sm">Byt</button></form> : null}<div className="tenant-chip"><span className="avatar">{initials(tenantName)}</span><div><strong>{tenantName}</strong><small>{email}</small></div></div><form action={signOut}><button className="button button-ghost button-sm">Logga ut</button></form></div></header>;
}
