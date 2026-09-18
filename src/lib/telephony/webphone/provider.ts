import "server-only";

export type WebphoneIceServer = { urls: string[]; username?: string; credential?: string };

/**
 * SIP över WebSocket. En webbläsare kan inte tala SIP på annat sätt.
 *
 * Ingen leverantör använder den här formen i dag. Den står kvar därför att den
 * är den enda vägen för en leverantör som säljer en SIP-trunk utan eget SDK,
 * och det är ett alternativ som var uppe i leverantörsvalet.
 */
export type SipWebphoneCredentials = {
  kind: "sip";
  /** SIP-adressen säljaren registrerar sig som. */
  sipUri: string;
  websocketUrl: string;
  realm: string;
  authorizationUser: string;
  password: string;
  /**
   * STUN/TURN. Utan TURN faller samtalet tyst bakom många företagsbrandväggar,
   * vilket är den vanligaste och svåraste felrapporten i en webbtelefon.
   */
  iceServers: WebphoneIceServer[];
};

/**
 * Sinch In-App Calling. Inte SIP — deras `sinch-rtc`-SDK sköter signalering,
 * media och ICE själv, så ingenting av SIP-formen ovan går att fylla i.
 *
 * Klienten byggs med applikationsnyckeln och användar-ID:t, ber om uppgifter
 * genom `onCredentialsRequired`, och får `token`. Hemligheten som signerar den
 * lämnar aldrig servern.
 */
export type SinchRtcWebphoneCredentials = {
  kind: "sinch_rtc";
  applicationKey: string;
  userId: string;
  environmentHost: string;
  /** Kortlivad JWT, signerad med applikationshemligheten på servern. */
  token: string;
  /**
   * A-numret, i E.164.
   *
   * Obligatoriskt, och tyst om det saknas: Sinch dokumenterar att ett samtal
   * utan CLI får ett samtals-ID i svaret men aldrig når mottagaren. Ett lyckat
   * svar för ett samtal som inte rings är precis den sortens lögn som den här
   * kodbasen har fått rensas på tre gånger, så fältet är inte valfritt här.
   */
  callerIdentifier: string;
};

/**
 * Uppgifterna webbtelefonen behöver för att registrera sig, och ingenting mer.
 *
 * De är avsiktligt kortlivade. En hemlighet som ligger kvar i webbläsaren är en
 * hemlighet på vift: den går att läsa ur minnet, ur en felrapport eller ur en
 * delad skärm, och den går inte att återkalla. `expiresAt` är därför inte en
 * detalj utan hela poängen — klienten måste hämta nya när de går ut.
 *
 * Formen skiljer sig mellan leverantörer på ett sätt som inte går att gömma
 * bakom gemensamma fält, så `kind` tvingar klienten att välja väg uttryckligen
 * i stället för att läsa fält som råkar vara tomma.
 */
export type WebphoneCredentials = { provider: string; expiresAt: string } & (
  | SipWebphoneCredentials
  | SinchRtcWebphoneCredentials
);

export type WebphoneProvisionResult =
  | { available: true; credentials: WebphoneCredentials }
  | { available: false; code: string; message: string };

export type WebphoneProvisionInput = {
  tenantId: string;
  sellerUserId: string;
  sessionId: string;
  /**
   * A-numret i E.164, eller null när tenanten inte har något.
   *
   * Null är ett giltigt läge som måste hanteras, inte ett fel att kasta:
   * ett nytt bolag har inget nummer förrän det beställts. Adaptern ska då
   * svara med ett nej som går att läsa, inte dela ut uppgifter som ger ett
   * samtal som aldrig når fram.
   */
  callerIdentifier: string | null;
};

export type WebphoneProvider = {
  key: string;
  /**
   * Har adaptern det den behöver för att kunna registrera en webbtelefon?
   *
   * Frågan hör hemma hos adaptern och ingen annanstans. Beredskapskontrollen
   * läste tidigare leverantörens miljövariabler direkt, vilket betydde att ett
   * leverantörsbyte tystade kontrollen i stället för att flytta den.
   */
  isConfigured(): boolean;
  provision(input: WebphoneProvisionInput): Promise<WebphoneProvisionResult>;
};
