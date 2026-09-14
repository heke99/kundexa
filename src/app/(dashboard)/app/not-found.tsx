import Link from "next/link";
import { ArrowLeft, Search } from "@/components/icons";

/**
 * Detail pages call `notFound()` when a record is missing or the tenant may not
 * see it. Without this the person got Next's unstyled default 404 in English.
 */
export default function AppNotFound() {
  return <div className="empty-state" style={{ paddingTop: 80 }}>
    <span className="stat-icon" style={{ width: 46, height: 46 }}><Search size={22} /></span>
    <h3>Posten finns inte</h3>
    <p>Den är borttagen, eller så ligger den utanför din behörighet. Kontrollera länken eller sök upp posten igen.</p>
    <div className="toolbar-left" style={{ marginTop: 18, justifyContent: "center" }}>
      <Link className="button button-secondary" href="/app"><ArrowLeft size={16} /> Till dashboarden</Link>
    </div>
  </div>;
}
