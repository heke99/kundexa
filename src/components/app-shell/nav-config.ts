import {
  Activity, BarChart3, Blocks, BookUser, Bot, BriefcaseBusiness, Building2, CalendarCheck2, CalendarDays,
  CircleDollarSign, ClipboardList, Contact, FileSignature, FileText, Headphones,
  Import, Inbox, KeyRound, LayoutList, ListFilter, Megaphone, MessageSquareText, Package,
  PhoneCall, Plug, ScrollText, Search, Settings, ShieldCheck, Users, Webhook,
  type LucideIcon,
} from "@/components/icons";

export type NavItem = { href: string; label: string; icon: LucideIcon };
export type NavSection = {
  id: string;
  label: string;
  items: NavItem[];
  /** Opens closed. For sections a person visits on setup day and rarely again. */
  collapsedByDefault?: boolean;
};

/**
 * Grouped by the job rather than by the data model.
 *
 * The previous grouping — Arbete / CRM / Avtal & kommunikation / Styrning — was
 * one taxonomy for everyone, so the only thing that changed between a seller and
 * an owner was how many rows the list had. A seller's three daily destinations
 * sat somewhere among seventeen.
 *
 * Sections are filtered per role by `canAccessRoute`, and a section with nothing
 * visible in it disappears entirely, so a seller sees four short sections and an
 * owner sees six with the settings one closed.
 *
 * Order is deliberate: the first section is what a seller opens the product to
 * do. `routeAccessMap` in lib/permissions stays the single source of truth for
 * who may reach what; this file only decides shape and order.
 */
export const navSections: NavSection[] = [
  { id: "ringa", label: "Ringa", items: [
    { href: "/app/dialer", label: "Dialer", icon: PhoneCall },
    { href: "/app/callbacks", label: "Återkomster", icon: CalendarCheck2 },
    { href: "/app/calls", label: "Mina samtal", icon: Headphones },
  ]},
  { id: "kunder", label: "Kunder", items: [
    { href: "/app/customers", label: "Kunder", icon: Contact },
    { href: "/app/companies", label: "Företag", icon: Building2 },
    { href: "/app/prospects", label: "Prospekt", icon: BookUser },
    { href: "/app/lists", label: "Ringlistor", icon: ListFilter },
    { href: "/app/directory", label: "Katalog & målgrupper", icon: Search },
    { href: "/app/imports", label: "Importer", icon: Import },
  ]},
  { id: "salj", label: "Sälj", items: [
    { href: "/app/contracts", label: "Avtal", icon: FileSignature },
    { href: "/app/orders", label: "Order", icon: ClipboardList },
    { href: "/app/pipeline", label: "Pipeline", icon: LayoutList },
    { href: "/app/products", label: "Produkter & priser", icon: Package },
    { href: "/app/templates", label: "Avtalsmallar", icon: ScrollText },
    { href: "/app/documents", label: "PDF-dokument", icon: FileText },
  ]},
  { id: "kommunikation", label: "Kommunikation", items: [
    { href: "/app/sms", label: "SMS", icon: MessageSquareText },
    { href: "/app/email", label: "E-post", icon: Inbox },
    { href: "/app/activities", label: "Aktiviteter", icon: Activity },
    { href: "/app/calendar", label: "Kalender", icon: CalendarDays },
    { href: "/app/campaigns", label: "Kampanjer", icon: Megaphone },
    { href: "/app/automations", label: "Automatiseringar", icon: Bot },
  ]},
  { id: "leda", label: "Leda", items: [
    { href: "/app/teams", label: "Team", icon: Users },
    { href: "/app/users", label: "Användare", icon: BriefcaseBusiness },
    { href: "/app/reports", label: "Rapporter", icon: BarChart3 },
  ]},
  { id: "installningar", label: "Inställningar", collapsedByDefault: true, items: [
    { href: "/app/admin", label: "Administration", icon: Settings },
    { href: "/app/integrations", label: "Integrationer", icon: Plug },
    { href: "/app/compliance", label: "Spärrar & compliance", icon: ShieldCheck },
    { href: "/app/security", label: "Säkerhet", icon: Blocks },
    { href: "/app/data-sources", label: "Datakällor", icon: ClipboardList },
    { href: "/app/billing", label: "Fakturering", icon: CircleDollarSign },
    { href: "/app/api", label: "API-nycklar", icon: KeyRound },
    { href: "/app/webhooks", label: "Webhooks", icon: Webhook },
  ]},
];
