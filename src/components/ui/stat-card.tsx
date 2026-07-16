import type { LucideIcon } from "@/components/icons";

export function StatCard({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string | number; detail?: string }) {
  return <div className="stat-card"><div className="stat-icon"><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div></div>;
}
