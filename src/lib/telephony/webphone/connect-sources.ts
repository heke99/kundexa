/**
 * Adresserna webbläsarens webbtelefon måste få ansluta till.
 *
 * Sajtens CSP släppte bara igenom sajten själv och Supabase. Webbtelefonens SDK
 * registrerar sig mot telefonitjänsten från webbläsaren, så varje registrering
 * blockerades av webbläsaren innan den nådde fram. Ingen session i produktion
 * registrerades någonsin, och servern -- som inte omfattas av CSP -- fick
 * samtidigt HTTP 200 på exakt samma begäran.
 *
 * - `*.sinch.com`: registrering, konfiguration och samtalsrapportering (OCRA).
 * - `*.pubnub.com`, `*.pndsn.com`: signaleringen går över PubNub, med
 *   värdnamnet från leverantörens konfiguration vid körning.
 *
 * Media (RTCPeerConnection/ICE) omfattas inte av `connect-src`.
 */
export const webphoneConnectSources = [
  "https://*.sinch.com",
  "wss://*.sinch.com",
  "https://*.pubnub.com",
  "wss://*.pubnub.com",
  "https://*.pndsn.com",
  "wss://*.pndsn.com",
] as const;
