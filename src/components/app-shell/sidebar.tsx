"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Logo } from "@/components/logo";
import { ChevronDown, Gauge, Menu, Phone, ShieldCheck, X } from "@/components/icons";
import { navSections, type NavSection } from "./nav-config";
import { cn } from "@/lib/utils";
import { canAccessRoute } from "@/lib/permissions";

const SECTION_STORAGE_KEY = "kundexa.nav.sections";

/**
 * Only sections the person has actually toggled. A plain list of collapsed ids
 * cannot express "not chosen": an empty list would read as "nothing is
 * collapsed", and a section that ships collapsed would spring open the moment
 * the stored value arrived after mount.
 */
type SectionOverrides = Record<string, boolean>;

function readSectionOverrides(): SectionOverrides {
  // Per-viewer convenience only. Private windows and cleared site data make this
  // throw or come back empty, and the nav has to render correctly either way.
  try {
    const raw = window.localStorage.getItem(SECTION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "boolean"),
    ) as SectionOverrides;
  } catch {
    return {};
  }
}

function isActive(pathname: string, href: string) {
  return href === "/app" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

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
  const [open, setOpen] = useState(false);
  const [overrides, setOverrides] = useState<SectionOverrides | null>(null);
  const mayManagePlatformTelephony = platformRole === "platform_owner" || platformRole === "platform_admin";

  // Read after mount so the server and the first client render agree; until then
  // every section renders open, which is the safe direction to be wrong in.
  useEffect(() => { setOverrides(readSectionOverrides()); }, []);

  // A drawer that survives navigation traps the person behind it on a phone.
  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const toggleSection = useCallback((id: string, open: boolean) => {
    setOverrides((current) => {
      const next = { ...(current ?? {}), [id]: !open };
      try { window.localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(next)); } catch { /* per-viewer only */ }
      return next;
    });
  }, []);

  const visibleSections: Array<NavSection & { hasActive: boolean }> = platformMode || !role ? [] : navSections
    .map((section) => {
      const items = section.items.filter((item) => canAccessRoute(role, item.href));
      return { ...section, items, hasActive: items.some((item) => isActive(pathname, item.href)) };
    })
    .filter((section) => section.items.length > 0);

  function sectionOpen(section: NavSection & { hasActive: boolean }) {
    // Never hide where the person currently is.
    if (section.hasActive) return true;
    const override = overrides?.[section.id];
    return override ?? !section.collapsedByDefault;
  }

  const nav = <nav>
    {!platformMode && role ? <div className="nav-group">
      <Link href="/app" className={cn("nav-link", pathname === "/app" && "active")}>
        <Gauge size={17} /><span>Dashboard</span>
      </Link>
    </div> : null}

    {visibleSections.map((section) => {
      const expanded = sectionOpen(section);
      return <div className="nav-group" key={section.id}>
        <button
          type="button"
          className="nav-section-toggle"
          aria-expanded={expanded}
          aria-controls={`nav-section-${section.id}`}
          onClick={() => toggleSection(section.id, expanded)}
        >
          <span>{section.label}</span>
          <ChevronDown size={13} className={cn("nav-chevron", !expanded && "nav-chevron-collapsed")} />
        </button>
        <div id={`nav-section-${section.id}`} className="nav-section-items" hidden={!expanded}>
          {section.items.map(({ href, label, icon: Icon }) => {
            const badge = href === "/app/callbacks" ? dueCallbacks : href === "/app/lists" ? activeLists : 0;
            return <Link key={href} href={href} className={cn("nav-link", isActive(pathname, href) && "active")}>
              <Icon size={17} /><span>{label}</span>
              {badge ? <strong className="nav-badge">{badge > 99 ? "99+" : badge}</strong> : null}
            </Link>;
          })}
        </div>
      </div>;
    })}

    {platformRole ? <div className="nav-group">
      <span className="nav-group-label">Plattform</span>
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
  </nav>;

  return <>
    {/* Below 760px the aside is hidden by the stylesheet and this is the only way
        to navigate at all — before it existed a phone could reach the dashboard
        and nothing else. Fixed rather than inside the topbar so no server
        component has to become a client one to hold the open state. */}
    <button
      type="button"
      className="nav-toggle"
      aria-label={open ? "Stäng menyn" : "Öppna menyn"}
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    >
      {open ? <X size={20} /> : <Menu size={20} />}
    </button>
    {open ? <button type="button" className="nav-backdrop" aria-label="Stäng menyn" onClick={() => setOpen(false)} /> : null}
    <aside className={cn("sidebar", open && "sidebar-open")}>
      <div className="sidebar-brand"><Logo /></div>
      {nav}
    </aside>
  </>;
}
