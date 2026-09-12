"use client";

import { useEffect } from "react";

/**
 * The acceptance link is the one page a customer sees, and it had no error
 * boundary: anything thrown reached the root fallback. The page itself used to
 * answer a failed read with `notFound()` — telling someone holding a valid link
 * that the agreement does not exist, which is the one message that makes them
 * stop trying instead of trying again.
 */
export default function AcceptError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error("acceptance_page_error", { digest: error.digest, name: error.name });
  }, [error]);

  return <main className="auth-page">
    <section className="auth-brand">
      <div>
        <h1>Avtalet kunde inte visas just nu</h1>
        <p>
          Det är ett tillfälligt fel hos oss, inte något fel på din länk. Ladda om sidan om en
          stund — länken fortsätter att gälla fram till sitt sista svarsdatum.
        </p>
      </div>
      <small>Hör av dig till den som skickade avtalet om problemet står kvar.</small>
    </section>
    <section className="auth-form-wrap">
      <div className="auth-form">
        <h2>Försök igen om en stund</h2>
        <p>Din länk är fortfarande giltig. Inget har skickats iväg och inget har accepterats.</p>
        {error.digest ? <p className="muted" style={{ fontSize: 12 }}>Referens: <code>{error.digest}</code></p> : null}
      </div>
    </section>
  </main>;
}
