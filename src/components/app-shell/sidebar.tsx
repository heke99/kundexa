"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { navGroups } from "./nav-config";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname();
  return <aside className="sidebar"><div className="sidebar-brand"><Logo /></div><nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map(({ href, label, icon: Icon }) => {
    const active = href === "/app" ? pathname === href : pathname.startsWith(href);
    return <Link key={href} href={href} className={cn("nav-link", active && "active")}><Icon size={17} /><span>{label}</span></Link>;
  })}</div>)}</nav></aside>;
}
