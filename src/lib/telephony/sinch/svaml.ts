/**
 * Svaret Sinch väntar sig på en samtalshändelse.
 *
 * ICE och ACE kräver ett SVAML-svar med en `action`. Rutten svarade med
 * `{ accepted: true }` på allt, och Sinch dokumenterar vad som händer då:
 * "If there is no response to the callback within the timeout period, an error
 * message is played, and the call is disconnected." Så fort callback-adressen
 * var registrerad hade varje utgående samtal brutits innan det ringde.
 *
 * - ICE från webbtelefonen till ett telefonnummer: `connectPstn`, men bara när
 *   databasen har en reservation för just det samtalet (`decision.connect`).
 *   Numret är det som reserverades och A-numret det som resolvern valde för
 *   listan, kampanjen eller teamet -- inte det klienten byggdes med. Utan
 *   reservation, eller om databasen inte svarade, läggs samtalet på: annars
 *   hade den som har en inloggad webbtelefon kunnat ringa vem som helst förbi
 *   spärrlistan, NIX och ringtiderna. Numret anges uttryckligen, som i varje
 *   exempel i Sinchs referens (utan det bröts samtalen med GENERALERROR).
 * - ICE för allt annat (inkommande samtal till våra nummer, app-till-app): `hangup`.
 *   Inkommande samtal stöds inte, och att koppla ett inkommande samtal till det
 *   nummer som ringdes hade skickat det i en slinga.
 * - ACE: `continue`.
 * - DiCE och notify tar inget SVAML.
 *
 * Fälten är hämtade ur developers.sinch.com/docs/voice/api-reference/voice/callbacks/ice
 * 2026-09-23.
 */
const E164 = /^\+[1-9][0-9]{7,14}$/;

type Payload = Record<string, unknown>;

export type SinchSvaml = { instructions: unknown[]; action: Record<string, unknown> };

/** Beskedet `ingest_sinch_voice_event` ger en ICE, ur den reserverade försöksraden. */
export type SinchIceDecision = { connect?: unknown; destination?: unknown; callerId?: unknown };

const HANGUP: SinchSvaml = { instructions: [], action: { name: "hangup" } };

// Sinch skickar klientens A-nummer utan plustecken ("12085810392"). Ett nummer
// som bara är siffror får sitt plus; allt annat som inte är E.164 räknas som saknat.
function e164(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = /^[1-9][0-9]{7,14}$/.test(raw) ? `+${raw}` : raw;
  return E164.test(normalized) ? normalized : null;
}

export function sinchSvamlFor(event: string, payload: Payload, decision?: SinchIceDecision | null): SinchSvaml | null {
  if (event === "ice") {
    const to = (payload.to && typeof payload.to === "object" ? payload.to : {}) as { type?: unknown; endpoint?: unknown };
    const toType = String(to.type ?? "").toLowerCase();
    const origination = String(payload.originationType ?? "").toLowerCase();
    const endpoint = typeof to.endpoint === "string" ? to.endpoint : "";
    if (toType !== "number" || origination === "pstn" || !E164.test(endpoint)) return HANGUP;
    // Ingen reservation, fel säljare eller fel nummer: lägg på.
    if (decision?.connect !== true) return HANGUP;
    const destination = e164(decision.destination);
    if (!destination || destination !== endpoint) return HANGUP;
    // Resolverns nummer först. Klientens eget är bara en reserv, och Sinch skriver
    // själva "You must provide a CLI or your call will fail".
    const cli = e164(decision.callerId) ?? e164(payload.cli);
    return {
      instructions: [],
      action: {
        name: "connectPstn",
        number: destination,
        ...(cli ? { cli } : {}),
        // Ett säljsamtal på två timmar är ett samtal någon glömt att lägga på.
        // Inget mer: varje valfritt fält är ett fält Sinch kan avvisa, och
        // svaret ska bara säga vart samtalet går och från vilket nummer.
        maxDuration: 7200,
      },
    };
  }
  if (event === "ace") return { instructions: [], action: { name: "continue" } };
  return null;
}
