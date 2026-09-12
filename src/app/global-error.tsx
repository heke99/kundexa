"use client";

/**
 * The last resort: an error thrown in the root layout itself, where the app
 * shell and its stylesheet are not available. It has to render its own <html>
 * and carry its own styles.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="sv">
    <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#f4f6f8", fontFamily: "Inter, system-ui, sans-serif", color: "#17202a" }}>
      <div style={{ maxWidth: 460, padding: 32, textAlign: "center" }}>
        <h1 style={{ fontSize: 22, marginBottom: 10 }}>Kundexa kunde inte starta sidan</h1>
        <p style={{ color: "#5c6b73", lineHeight: 1.6 }}>
          Ladda om sidan. Kvarstår felet, kontakta en administratör och uppge referensen nedan.
        </p>
        {error.digest ? <p style={{ color: "#7b888e", fontSize: 12 }}>Referens: <code>{error.digest}</code></p> : null}
        <button
          type="button"
          onClick={reset}
          style={{ marginTop: 18, border: 0, borderRadius: 10, padding: "10px 16px", fontWeight: 700, background: "#107a64", color: "white" }}
        >
          Försök igen
        </button>
      </div>
    </body>
  </html>;
}
