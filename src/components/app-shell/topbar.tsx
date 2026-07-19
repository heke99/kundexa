import { Bell, Search } from "@/components/icons";
import { initials } from "@/lib/utils";
import { signOut } from "@/app/actions/auth";

export function Topbar({ tenantName, email, notificationCount = 0 }: { tenantName: string; email: string; notificationCount?: number }) {
  return <header className="topbar"><div className="global-search"><Search size={17} /><input aria-label="Global sökning" placeholder="Sök kund, företag, avtal eller nummer…" /></div><div className="topbar-actions"><a className="icon-button notification-button" aria-label={`${notificationCount} förfallna återkomster`} href="/app/callbacks"><Bell size={19} />{notificationCount ? <span>{notificationCount > 99 ? "99+" : notificationCount}</span> : null}</a><div className="tenant-chip"><span className="avatar">{initials(tenantName)}</span><div><strong>{tenantName}</strong><small>{email}</small></div></div><form action={signOut}><button className="button button-ghost button-sm">Logga ut</button></form></div></header>;
}
