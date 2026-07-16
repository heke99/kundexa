import Link from "next/link";

export function Logo({ compact = false }: { compact?: boolean }) {
  return <Link className="logo" href="/"><span className="logo-mark">K</span>{compact ? null : <span>Kundexa</span>}</Link>;
}
