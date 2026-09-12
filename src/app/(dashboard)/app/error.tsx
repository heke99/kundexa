"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Ban, ArrowLeft, RefreshCw } from "@/components/icons";
import { permissionDeniedDigest } from "@/lib/permissions";

/**
 * Until this existed, anything thrown while rendering a tab — a failed read, a
 * lost connection, an action the role is not allowed to run — reached Next's own
 * error screen: "Application error: a server-side exception has occurred" and a
 * digest, in English, with no way back.
 *
 * `assertPermission` throws `permission_denied:<permission>`, and several pages
 * still render forms the viewer's role will refuse, so that was a reachable
 * path rather than a theoretical one.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The message can carry internals; it belongs in the server log, not on screen.
    console.error("app_route_error", { digest: error.digest, name: error.name });
  }, [error]);

  // Read the marker off `digest`, never off `message`: in a production build
  // React replaces a server error's message with "An error occurred in the
  // Server Components render…" and forwards only the digest. Matching on the
  // message worked in `next dev` and silently never matched in production.
  const permission = permissionDeniedDigest(error.digest);

  return <div className="empty-state" style={{ paddingTop: 80 }}>
    <span className="stat-icon" style={{ width: 46, height: 46 }}><Ban size={22} /></span>
    <h3>{permission ? "Du saknar behörighet för den åtgärden" : "Något gick fel på den här sidan"}</h3>
    <p>
      {permission
        ? "Din roll får inte utföra åtgärden. Be en administratör om behörighet, eller gå tillbaka och fortsätt med det du får göra."
        : "Sidan kunde inte visas. Försök igen — går det inte, gå tillbaka till dashboarden och kontakta en administratör."}
    </p>
    {permission ? <p className="muted" style={{ fontSize: 12 }}>Behörighet som krävs: <code>{permission}</code></p>
      : error.digest ? <p className="muted" style={{ fontSize: 12 }}>Referens: <code>{error.digest}</code></p> : null}
    <div className="toolbar-left" style={{ marginTop: 18, justifyContent: "center" }}>
      {/* Retrying a refusal just refuses again, so the button is only offered
          where trying again can actually change the outcome. */}
      {permission ? null : <button type="button" className="button button-primary" onClick={reset}><RefreshCw size={16} /> Försök igen</button>}
      <Link className={permission ? "button button-primary" : "button button-secondary"} href="/app"><ArrowLeft size={16} /> Till dashboarden</Link>
    </div>
  </div>;
}
