"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { Phone, ShieldCheck } from "@/components/icons";
import { navGroups } from "./nav-config";
import { cn } from "@/lib/utils";
import { canAccessRoute } from "@/lib/permissions";

export function Sidebar({
  platformRole,
  role,
  dueCallbacks = 0,
  activeLists = 0,
  platformMode = false,
  hasActiveTenant = true,
}: {
  platformRole?: string | null;
  role?: string | null;
  dueCallbacks?: number;
  activeLists?: number;
  platformMode?: boolean;
  hasActiveTenant?: boolean;
}) {
  const pathname = usePathname();
  const mayManagePlatformTelephony = platformRole === "platform_owner" || platformRole === "platform_admin";

  return <aside className="sidebar">
    <div className="sidebar-brand"><Logo /></div>
    <nav>
      {!platformMode ? navGroups.map((group) => {
        const visibleItems = group.items.filter(({ href }) => role ? canAccessRoute(role, href) : false);
        if (!visibleItems.length) return null;
        return <div className="nav-group" key={group.label}>
        <span>{group.label}</span>
        {visibleItems.map(({ href, label, icon: Icon }) => {
          const active = href === "/app" ? pathname === href : pathname.startsWith(href);
          const badge = href === "/app/callbacks" ? dueCallbacks : href === "/app/lists" ? activeLists : 0;
          return <Link key={href} href={href} className={cn("nav-link", active && "active")}>
            <Icon size={17} /><span>{label}</span>{badge ? <strong className="nav-badge">{badge > 99 ? "99+" : badge}</strong> : null}
          </Link>;
        })}
      </div>;
      }) : null}

      {platformRole ? <div className="nav-group">
        <span>Plattform</span>
        <Link href="/app/platform" className={cn("nav-link", pathname === "/app/platform" && "active")}>
          <ShieldCheck size={17} /><span>Plattformsadmin</span>
        </Link>
        {mayManagePlatformTelephony ? <Link href="/app/platform/telephony" className={cn("nav-link", pathname.startsWith("/app/platform/telephony") && "active")}>
          <Phone size={17} /><span>Rinkeltelefoni</span>
        </Link> : null}
        {platformMode && hasActiveTenant ? <Link href="/app" className="nav-link">
          <ShieldCheck size={17} /><span>Tenantdashboard</span>
        </Link> : null}
      </div> : null}
    </nav>
  </aside>;
}
