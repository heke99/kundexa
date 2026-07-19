import { Bell, Search } from "@/components/icons";
import { initials } from "@/lib/utils";
import { signOut } from "@/app/actions/auth";

export function Topbar({ tenantName, email }: { tenantName: string; email: string }) {
  return <header className="topbar"><div className="global-search"><Search size={17} /><input aria-label="Global sökning" placeholder="Sök kund, företag, avtal eller nummer…" /></div><div className="topbar-actions"><button className="icon-button" aria-label="Notiser"><Bell size={19} /></button><div className="tenant-chip"><span className="avatar">{initials(tenantName)}</span><div><strong>{tenantName}</strong><small>{email}</small></div></div><form action={signOut}><button className="button button-ghost button-sm">Logga ut</button></form></div></header>;
}
