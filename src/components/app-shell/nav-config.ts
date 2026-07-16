import {
  Activity, BarChart3, Blocks, BookUser, Bot, BriefcaseBusiness, Building2, CalendarDays,
  CircleDollarSign, ClipboardList, Contact, FileSignature, FileText, Gauge, Headphones,
  Import, Inbox, KeyRound, LayoutList, ListFilter, Megaphone, MessageSquareText, Package,
  PhoneCall, PhoneForwarded, Plug, ScrollText, Search, Settings, ShieldCheck, Users, Webhook,
} from "@/components/icons";

export const navGroups = [
  { label: "Arbete", items: [
    { href: "/app", label: "Dashboard", icon: Gauge },
    { href: "/app/dialer", label: "Dialer", icon: PhoneCall },
    { href: "/app/calls", label: "Mina samtal", icon: Headphones },
    { href: "/app/queues", label: "Samtalsköer", icon: PhoneForwarded },
    { href: "/app/activities", label: "Aktiviteter", icon: Activity },
    { href: "/app/calendar", label: "Kalender", icon: CalendarDays },
  ]},
  { label: "CRM", items: [
    { href: "/app/customers", label: "Kunder", icon: Contact },
    { href: "/app/companies", label: "Företag", icon: Building2 },
    { href: "/app/directory", label: "Katalog & målgrupper", icon: Search },
    { href: "/app/prospects", label: "Prospekt", icon: BookUser },
    { href: "/app/lists", label: "Listor", icon: ListFilter },
    { href: "/app/imports", label: "Importer", icon: Import },
    { href: "/app/campaigns", label: "Kampanjer", icon: Megaphone },
    { href: "/app/pipeline", label: "Pipeline", icon: LayoutList },
  ]},
  { label: "Avtal & kommunikation", items: [
    { href: "/app/contracts", label: "Avtal", icon: FileSignature },
    { href: "/app/documents", label: "PDF-dokument", icon: FileText },
    { href: "/app/templates", label: "Avtalsmallar", icon: ScrollText },
    { href: "/app/products", label: "Produkter & priser", icon: Package },
    { href: "/app/sms", label: "SMS", icon: MessageSquareText },
    { href: "/app/email", label: "E-post", icon: Inbox },
    { href: "/app/automations", label: "Automatiseringar", icon: Bot },
  ]},
  { label: "Styrning", items: [
    { href: "/app/teams", label: "Team", icon: Users },
    { href: "/app/users", label: "Användare", icon: BriefcaseBusiness },
    { href: "/app/reports", label: "Rapporter", icon: BarChart3 },
    { href: "/app/integrations", label: "Integrationer", icon: Plug },
    { href: "/app/api", label: "API-nycklar", icon: KeyRound },
    { href: "/app/webhooks", label: "Webhooks", icon: Webhook },
    { href: "/app/compliance", label: "Spärrar & compliance", icon: ShieldCheck },
    { href: "/app/security", label: "Säkerhet", icon: Blocks },
    { href: "/app/admin", label: "Administration", icon: Settings },
    { href: "/app/billing", label: "Fakturering", icon: CircleDollarSign },
    { href: "/app/data-sources", label: "Datakällor", icon: ClipboardList },
  ]},
];
