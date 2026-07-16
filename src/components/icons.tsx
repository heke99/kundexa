import { forwardRef, type SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  size?: number | string;
  strokeWidth?: number;
};

type IconComponent = ReturnType<typeof createIcon>;
export type LucideIcon = IconComponent;

function createIcon(name: string, variant = 0) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function KundexaIcon(
    { size = 24, strokeWidth = 2, children, ...props },
    ref,
  ) {
    const paths = [
      <><rect key="r" x="4" y="4" width="16" height="16" rx="4" /><path key="p" d="M8 12h8M12 8v8" /></>,
      <><circle key="c" cx="12" cy="12" r="8" /><path key="p" d="m9 12 2 2 4-5" /></>,
      <><path key="p1" d="M5 19V9l7-5 7 5v10" /><path key="p2" d="M9 19v-6h6v6" /></>,
      <><path key="p1" d="M5 6h14v12H5z" /><path key="p2" d="m5 8 7 5 7-5" /></>,
    ];
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
        {paths[variant % paths.length]}
        {children}
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}

const definitions = {
  Activity: 0, ArrowLeft: 1, ArrowRight: 1, Ban: 1, BarChart3: 0, Bell: 1,
  Blocks: 0, BookUser: 2, Bot: 0, BriefcaseBusiness: 2, Building2: 2,
  CalendarCheck2: 1, CalendarDays: 0, CalendarPlus: 0, CheckCircle2: 1,
  CircleDollarSign: 1, ClipboardList: 0, Clock3: 1, Contact: 2, Download: 1,
  FileCheck2: 1, FileSignature: 0, FileText: 0, Gauge: 1, Headphones: 1,
  Import: 1, Inbox: 3, KeyRound: 1, LayoutList: 0, ListFilter: 0,
  LockKeyhole: 1, Mail: 3, Megaphone: 1, MessageSquareText: 3, Package: 2,
  Phone: 1, PhoneCall: 1, PhoneForwarded: 1, PhoneOff: 1, Plug: 0, Plus: 0,
  Radio: 1, ScrollText: 0, Search: 1, Send: 1, Settings: 0, ShieldCheck: 1,
  StickyNote: 0, Target: 1, TrendingUp: 1, Upload: 1, UserPlus: 1, Users: 2,
  Webhook: 0,
} as const;

export const Activity: IconComponent = createIcon("Activity", definitions.Activity);
export const ArrowLeft: IconComponent = createIcon("ArrowLeft", definitions.ArrowLeft);
export const ArrowRight: IconComponent = createIcon("ArrowRight", definitions.ArrowRight);
export const Ban: IconComponent = createIcon("Ban", definitions.Ban);
export const BarChart3: IconComponent = createIcon("BarChart3", definitions.BarChart3);
export const Bell: IconComponent = createIcon("Bell", definitions.Bell);
export const Blocks: IconComponent = createIcon("Blocks", definitions.Blocks);
export const BookUser: IconComponent = createIcon("BookUser", definitions.BookUser);
export const Bot: IconComponent = createIcon("Bot", definitions.Bot);
export const BriefcaseBusiness: IconComponent = createIcon("BriefcaseBusiness", definitions.BriefcaseBusiness);
export const Building2: IconComponent = createIcon("Building2", definitions.Building2);
export const CalendarCheck2: IconComponent = createIcon("CalendarCheck2", definitions.CalendarCheck2);
export const CalendarDays: IconComponent = createIcon("CalendarDays", definitions.CalendarDays);
export const CalendarPlus: IconComponent = createIcon("CalendarPlus", definitions.CalendarPlus);
export const CheckCircle2: IconComponent = createIcon("CheckCircle2", definitions.CheckCircle2);
export const CircleDollarSign: IconComponent = createIcon("CircleDollarSign", definitions.CircleDollarSign);
export const ClipboardList: IconComponent = createIcon("ClipboardList", definitions.ClipboardList);
export const Clock3: IconComponent = createIcon("Clock3", definitions.Clock3);
export const Contact: IconComponent = createIcon("Contact", definitions.Contact);
export const Download: IconComponent = createIcon("Download", definitions.Download);
export const FileCheck2: IconComponent = createIcon("FileCheck2", definitions.FileCheck2);
export const FileSignature: IconComponent = createIcon("FileSignature", definitions.FileSignature);
export const FileText: IconComponent = createIcon("FileText", definitions.FileText);
export const Gauge: IconComponent = createIcon("Gauge", definitions.Gauge);
export const Headphones: IconComponent = createIcon("Headphones", definitions.Headphones);
export const Import: IconComponent = createIcon("Import", definitions.Import);
export const Inbox: IconComponent = createIcon("Inbox", definitions.Inbox);
export const KeyRound: IconComponent = createIcon("KeyRound", definitions.KeyRound);
export const LayoutList: IconComponent = createIcon("LayoutList", definitions.LayoutList);
export const ListFilter: IconComponent = createIcon("ListFilter", definitions.ListFilter);
export const LockKeyhole: IconComponent = createIcon("LockKeyhole", definitions.LockKeyhole);
export const Mail: IconComponent = createIcon("Mail", definitions.Mail);
export const Megaphone: IconComponent = createIcon("Megaphone", definitions.Megaphone);
export const MessageSquareText: IconComponent = createIcon("MessageSquareText", definitions.MessageSquareText);
export const Package: IconComponent = createIcon("Package", definitions.Package);
export const Phone: IconComponent = createIcon("Phone", definitions.Phone);
export const PhoneCall: IconComponent = createIcon("PhoneCall", definitions.PhoneCall);
export const PhoneForwarded: IconComponent = createIcon("PhoneForwarded", definitions.PhoneForwarded);
export const PhoneOff: IconComponent = createIcon("PhoneOff", definitions.PhoneOff);
export const Plug: IconComponent = createIcon("Plug", definitions.Plug);
export const Plus: IconComponent = createIcon("Plus", definitions.Plus);
export const Radio: IconComponent = createIcon("Radio", definitions.Radio);
export const ScrollText: IconComponent = createIcon("ScrollText", definitions.ScrollText);
export const Search: IconComponent = createIcon("Search", definitions.Search);
export const Send: IconComponent = createIcon("Send", definitions.Send);
export const Settings: IconComponent = createIcon("Settings", definitions.Settings);
export const ShieldCheck: IconComponent = createIcon("ShieldCheck", definitions.ShieldCheck);
export const StickyNote: IconComponent = createIcon("StickyNote", definitions.StickyNote);
export const Target: IconComponent = createIcon("Target", definitions.Target);
export const TrendingUp: IconComponent = createIcon("TrendingUp", definitions.TrendingUp);
export const Upload: IconComponent = createIcon("Upload", definitions.Upload);
export const UserPlus: IconComponent = createIcon("UserPlus", definitions.UserPlus);
export const Users: IconComponent = createIcon("Users", definitions.Users);
export const Webhook: IconComponent = createIcon("Webhook", definitions.Webhook);
