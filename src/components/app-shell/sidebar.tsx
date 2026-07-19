"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { ShieldCheck } from "@/components/icons";
import { navGroups } from "./nav-config";
import { cn } from "@/lib/utils";

export function Sidebar({ platformRole, dueCallbacks = 0, activeLists = 0 }: { platformRole?: string | null; dueCallbacks?: number; activeLists?: number }) {
  const pathname = usePathname();
  return <aside className="sidebar"><div className="sidebar-brand"><Logo /></div><nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map(({ href, label, icon: Icon }) => {
    const active = href === "/app" ? pathname === href : pathname.startsWith(href);
    const badge = href === "/app/callbacks" ? dueCallbacks : href === "/app/lists" ? activeLists : 0;
    return <Link key={href} href={href} className={cn("nav-link", active && "active")}><Icon size={17} /><span>{label}</span>{badge ? <strong className="nav-badge">{badge > 99 ? "99+" : badge}</strong> : null}</Link>;
  })}</div>)}{platformRole ? <div className="nav-group"><span>Plattform</span><Link href="/app/platform" className={cn("nav-link", pathname.startsWith("/app/platform") && "active")}><ShieldCheck size={17} /><span>Plattformsadmin</span></Link></div> : null}</nav></aside>;
}
