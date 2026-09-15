import "server-only";

/**
 * Uppgifterna webbtelefonen behöver för att registrera sig, och ingenting mer.
 *
 * De är avsiktligt kortlivade. Ett SIP-lösenord som ligger kvar i webbläsaren
 * är ett lösenord på vift: det går att läsa ur minnet, ur en felrapport eller
 * ur en delad skärm, och det går inte att återkalla. `expiresAt` är därför inte
 * en detalj utan hela poängen — klienten måste hämta nya när de går ut.
 */
export type WebphoneCredentials = {
  provider: string;
  /** SIP-adressen säljaren registrerar sig som. */
  sipUri: string;
  /** SIP över WebSocket. En webbläsare kan inte tala SIP på annat sätt. */
  websocketUrl: string;
  realm: string;
  authorizationUser: string;
  password: string;
  /**
   * STUN/TURN. Utan TURN faller samtalet tyst bakom många företagsbrandväggar,
   * vilket är den vanligaste och svåraste felrapporten i en webbtelefon.
   */
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  expiresAt: string;
};

/**
 * Antingen går det, eller så säger vi varför det inte går.
 *
 * Ingen tredje utväg. En adapter som returnerar tomma uppgifter i stället för
 * ett nej ger en webbtelefon som tyst vägrar registrera sig, och då står
 * säljaren med en knapp som inte gör något och ingen aning om varför.
 */
export type WebphoneProvisionResult =
  | { available: true; credentials: WebphoneCredentials }
  | { available: false; code: string; message: string };

export type WebphoneProvisionInput = {
  tenantId: string;
  sellerUserId: string;
  sessionId: string;
};

export type WebphoneProvider = {
  key: string;
  provision(input: WebphoneProvisionInput): Promise<WebphoneProvisionResult>;
};
