import { forwardRef, type SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  size?: number | string;
  strokeWidth?: number;
};

type IconComponent = ReturnType<typeof createIcon>;
export type LucideIcon = IconComponent;

/**
 * Every icon used to be one of four generic glyphs picked by index, so the
 * sidebar showed the same circle-check, house, envelope and plus-square on
 * repeat — and often wrongly: an envelope for "Prospekt", a house for "Avtal".
 * An icon that does not distinguish its item is worse than no icon, because it
 * still costs the row 28px and invites a misread.
 *
 * Each name now carries its own 24x24 path, drawn on the same grid with the same
 * stroke so they read as one set.
 */
const definitions: Record<string, string> = {
  Activity: "M3 12h4l3 8 4-16 3 8h4",
  ArrowLeft: "M19 12H5m0 0 6-6m-6 6 6 6",
  ArrowRight: "M5 12h14m0 0-6-6m6 6-6 6",
  Ban: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm6.4 2.6L5.6 18.4",
  BarChart3: "M4 20V4M4 20h16M8 20v-6M13 20V9M18 20v-9",
  Bell: "M18 16V11a6 6 0 1 0-12 0v5l-2 3h16l-2-3ZM10 22h4",
  Blocks: "M4 4h7v7H4zM13 13h7v7h-7zM13 4h7v7h-7zM4 13h7v7H4z",
  BookUser: "M5 4a2 2 0 0 1 2-2h12v18H7a2 2 0 0 0-2 2V4Zm8 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-3 8a3 3 0 0 1 6 0",
  Bot: "M12 2v3M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm2 5v2m6-2v2M9 16h6",
  BriefcaseBusiness: "M4 8h16a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a1 1 0 0 1 1-1Zm5 0V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M3 13h18",
  Building2: "M4 21V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15M12 10h7a1 1 0 0 1 1 1v10M3 21h18M7 9h2m-2 4h2m-2 4h2m7-4h2m-2 4h2",
  CalendarCheck2: "M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3-3v4m8-4v4M4 10h16m-11 5 2 2 4-4",
  CalendarDays: "M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3-3v4m8-4v4M4 10h16M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01",
  CalendarPlus: "M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3-3v4m8-4v4M4 10h16m-8 3v5m-2.5-2.5h5",
  CheckCircle2: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-3.5 9 2.5 2.5 4.5-5",
  CircleDollarSign: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm2.5 5.5h-3a1.75 1.75 0 0 0 0 3.5h2a1.75 1.75 0 0 1 0 3.5h-3M12 6.5v11",
  ClipboardList: "M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Zm-1 2H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2M8.5 11h7m-7 3.5h7m-7 3.5h4",
  Clock3: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5h4",
  Contact: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm7 4.5a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5ZM8 17a4 4 0 0 1 8 0",
  Download: "M12 3v11m0 0 4-4m-4 4-4-4M5 19h14",
  FileCheck2: "M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Zm0 0v4h4M9.5 14l2 2 3.5-3.5",
  FileSignature: "M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-6M14 3v4h4M9 17h2m3.5-6.5 4 4-4.5 1.5.5-5.5Z",
  FileText: "M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Zm0 0v4h4M9 12h6M9 16h4",
  Gauge: "M12 14 16 9M4.5 17a9 9 0 1 1 15 0M12 14a1 1 0 1 0 0 .01",
  Headphones: "M4 15v-3a8 8 0 1 1 16 0v3m-16 0a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2v-2Zm16 0a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2v-2Z",
  Import: "M12 3v10m0 0 4-4m-4 4-4-4M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5",
  Inbox: "M4 13h4l1.5 3h5L16 13h4M4 13 6.5 5.5A1 1 0 0 1 7.5 5h9a1 1 0 0 1 1 .5L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5Z",
  KeyRound: "M15.5 3a5.5 5.5 0 1 0-4.2 9.05L10 13.5H8v2H6v2H3v-2.5l7.3-7.3A5.5 5.5 0 0 0 15.5 3Zm.5 3.5h.01",
  LayoutList: "M4 5h6v6H4zM4 15h6v4H4zM13 6h7M13 10h7M13 16h7M13 19h4",
  ListFilter: "M4 6h16M7 12h10M10 18h4",
  LockKeyhole: "M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Zm2 0V7a4 4 0 1 1 8 0v3m-4 4.5v2",
  Mail: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm-1 1.5 9 6 9-6",
  Megaphone: "M4 10v4a1 1 0 0 0 1 1h2l8 4V5L7 9H5a1 1 0 0 0-1 1Zm14 0a3 3 0 0 1 0 4M7 15v4",
  MessageSquareText: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1Zm4 4h8M8 12.5h5",
  Package: "M12 3 4 7v10l8 4 8-4V7l-8-4Zm0 0v18M4 7l8 4 8-4",
  Pause: "M9 5v14M15 5v14",
  Play: "M7 4.5v15l13-7.5-13-7.5Z",
  Phone: "M6 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L16 13l5 2v3a3 3 0 0 1-3 3A15 15 0 0 1 3 6a3 3 0 0 1 3-3Z",
  PhoneCall: "M6 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L16 13l5 2v3a3 3 0 0 1-3 3A15 15 0 0 1 3 6a3 3 0 0 1 3-3Zm9 0a6 6 0 0 1 6 6",
  PhoneForwarded: "M6 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L16 13l5 2v3a3 3 0 0 1-3 3A15 15 0 0 1 3 6a3 3 0 0 1 3-3Zm9 3h6m0 0-2.5-2.5M21 6l-2.5 2.5",
  PhoneOff: "M11 8 9 3H6a3 3 0 0 0-3 3 15 15 0 0 0 4 9m4 4a15 15 0 0 0 4 2 3 3 0 0 0 3-3v-3l-5-2-1.5 2.5M3 3l18 18",
  Plug: "M9 3v6m6-6v6M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9Zm6 12v-3",
  Plus: "M12 5v14M5 12h14",
  Radio: "M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-3.5-2a5 5 0 0 0 0 7m7-7a5 5 0 0 1 0 7m-10-10a9 9 0 0 0 0 13m13-13a9 9 0 0 1 0 13",
  RefreshCw: "M20 11A8 8 0 0 0 6.3 6.3L4 8.5M4 5v3.5H7.5M4 13a8 8 0 0 0 13.7 4.7L20 15.5M20 19v-3.5h-3.5",
  ScrollText: "M6 4h11a1 1 0 0 1 1 1v13a2 2 0 0 0 2 2H7a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Zm2.5 4h6m-6 3.5h6m-6 3.5h4M18 20a2 2 0 0 0 2-2v-2h-4",
  Search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 5 5",
  Send: "M21 3 3 10.5l7 3 3 7L21 3Zm0 0-11 11",
  Settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.4 7.4 0 0 0-2-1.2L14.5 2h-4l-.4 2.6a7.4 7.4 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.5l-2 1.5 2 3.4 2.3-1a7.4 7.4 0 0 0 2.1 1.2l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2Z",
  ShieldCheck: "M12 3l7 3v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6l7-3Zm-3 8.5 2.5 2.5 4-4.5",
  StickyNote: "M5 4h14a1 1 0 0 1 1 1v9l-6 6H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm15 10h-5a1 1 0 0 0-1 1v5",
  Target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 3.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  TrendingUp: "M3 17 9.5 10.5l3.5 3.5L21 6m0 0h-5m5 0v5",
  Upload: "M12 14V3m0 0 4 4m-4-4L8 7M5 19h14",
  UserPlus: "M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0M18 8v6m-3-3h6",
  Users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0m1-15.5a3.5 3.5 0 0 1 0 7M17 20a6 6 0 0 0-2-4.5",
  Webhook: "M9.5 9a3 3 0 1 1 4.3 2.7L17 17m-7.5-8L6.5 14.5M8 20a3 3 0 1 1 2.6-4.5H17M16 20a3 3 0 0 0 2.6-4.5L15 9.5",
  Menu: "M4 7h16M4 12h16M4 17h16",
  X: "m6 6 12 12M18 6 6 18",
  ChevronDown: "m6 9 6 6 6-6",
};

const FALLBACK = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z";

function createIcon(name: string) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function KundexaIcon(
    { size = 24, strokeWidth = 2, children, ...props },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={props["aria-label"] ? undefined : true}
        data-icon={name}
        {...props}
      >
        <path d={definitions[name] ?? FALLBACK} />
        {children}
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}

export const Activity: IconComponent = createIcon("Activity");
export const ArrowLeft: IconComponent = createIcon("ArrowLeft");
export const ArrowRight: IconComponent = createIcon("ArrowRight");
export const Ban: IconComponent = createIcon("Ban");
export const BarChart3: IconComponent = createIcon("BarChart3");
export const Bell: IconComponent = createIcon("Bell");
export const Blocks: IconComponent = createIcon("Blocks");
export const BookUser: IconComponent = createIcon("BookUser");
export const Bot: IconComponent = createIcon("Bot");
export const BriefcaseBusiness: IconComponent = createIcon("BriefcaseBusiness");
export const Building2: IconComponent = createIcon("Building2");
export const CalendarCheck2: IconComponent = createIcon("CalendarCheck2");
export const CalendarDays: IconComponent = createIcon("CalendarDays");
export const CalendarPlus: IconComponent = createIcon("CalendarPlus");
export const CheckCircle2: IconComponent = createIcon("CheckCircle2");
export const CircleDollarSign: IconComponent = createIcon("CircleDollarSign");
export const ClipboardList: IconComponent = createIcon("ClipboardList");
export const Clock3: IconComponent = createIcon("Clock3");
export const Contact: IconComponent = createIcon("Contact");
export const Download: IconComponent = createIcon("Download");
export const FileCheck2: IconComponent = createIcon("FileCheck2");
export const FileSignature: IconComponent = createIcon("FileSignature");
export const FileText: IconComponent = createIcon("FileText");
export const Gauge: IconComponent = createIcon("Gauge");
export const Headphones: IconComponent = createIcon("Headphones");
export const Import: IconComponent = createIcon("Import");
export const Inbox: IconComponent = createIcon("Inbox");
export const KeyRound: IconComponent = createIcon("KeyRound");
export const LayoutList: IconComponent = createIcon("LayoutList");
export const ListFilter: IconComponent = createIcon("ListFilter");
export const LockKeyhole: IconComponent = createIcon("LockKeyhole");
export const Mail: IconComponent = createIcon("Mail");
export const Megaphone: IconComponent = createIcon("Megaphone");
export const MessageSquareText: IconComponent = createIcon("MessageSquareText");
export const Package: IconComponent = createIcon("Package");
export const Pause: IconComponent = createIcon("Pause");
export const Play: IconComponent = createIcon("Play");
export const Phone: IconComponent = createIcon("Phone");
export const PhoneCall: IconComponent = createIcon("PhoneCall");
export const PhoneForwarded: IconComponent = createIcon("PhoneForwarded");
export const PhoneOff: IconComponent = createIcon("PhoneOff");
export const Plug: IconComponent = createIcon("Plug");
export const Plus: IconComponent = createIcon("Plus");
export const Radio: IconComponent = createIcon("Radio");
export const RefreshCw: IconComponent = createIcon("RefreshCw");
export const ScrollText: IconComponent = createIcon("ScrollText");
export const Menu: IconComponent = createIcon("Menu");
export const X: IconComponent = createIcon("X");
export const ChevronDown: IconComponent = createIcon("ChevronDown");
export const Search: IconComponent = createIcon("Search");
export const Send: IconComponent = createIcon("Send");
export const Settings: IconComponent = createIcon("Settings");
export const ShieldCheck: IconComponent = createIcon("ShieldCheck");
export const StickyNote: IconComponent = createIcon("StickyNote");
export const Target: IconComponent = createIcon("Target");
export const TrendingUp: IconComponent = createIcon("TrendingUp");
export const Upload: IconComponent = createIcon("Upload");
export const UserPlus: IconComponent = createIcon("UserPlus");
export const Users: IconComponent = createIcon("Users");
export const Webhook: IconComponent = createIcon("Webhook");
