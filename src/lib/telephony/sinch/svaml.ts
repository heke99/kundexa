/**
 * Svaret Sinch väntar sig på en samtalshändelse.
 *
 * ICE och ACE kräver ett SVAML-svar med en `action`. Rutten svarade med
 * `{ accepted: true }` på allt, och Sinch dokumenterar vad som händer då:
 * "If there is no response to the callback within the timeout period, an error
 * message is played, and the call is disconnected." Så fort callback-adressen
 * var registrerad hade varje utgående samtal brutits innan det ringde.
 *
 * - ICE från webbtelefonen till ett telefonnummer: `connectPstn`. Numret utelämnas
 *   med flit ("If not specified, the extension the client called is used"), och
 *   A-numret är det klienten redan satt, om det är giltigt.
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

export function sinchSvamlFor(event: string, payload: Payload): SinchSvaml | null {
  if (event === "ice") {
    const to = (payload.to && typeof payload.to === "object" ? payload.to : {}) as { type?: unknown; endpoint?: unknown };
    const toType = String(to.type ?? "").toLowerCase();
    const origination = String(payload.originationType ?? "").toLowerCase();
    const endpoint = typeof to.endpoint === "string" ? to.endpoint : "";
    if (toType === "number" && origination !== "pstn" && E164.test(endpoint)) {
      // Sinch skickar klientens A-nummer utan plustecken ("12085810392").
      // Kontrollen krävde plus, så svaret gick utan `cli` -- och Sinch skriver
      // själva "You must provide a CLI or your call will fail". Det var
      // precis så det första samtalet via webhooken bröts.
      const rawCli = typeof payload.cli === "string" ? payload.cli.trim() : "";
      const normalizedCli = /^[1-9][0-9]{7,14}$/.test(rawCli) ? `+${rawCli}` : rawCli;
      const cli = E164.test(normalizedCli) ? normalizedCli : null;
      return {
        instructions: [],
        action: {
          name: "connectPstn",
          ...(cli ? { cli } : {}),
          // Ett säljsamtal på två timmar är ett samtal någon glömt att lägga på.
          // Inget mer: varje valfritt fält är ett fält Sinch kan avvisa, och
          // svaret ska bara säga vart samtalet går och från vilket nummer.
          maxDuration: 7200,
        },
      };
    }
    return { instructions: [], action: { name: "hangup" } };
  }
  if (event === "ace") return { instructions: [], action: { name: "continue" } };
  return null;
}
