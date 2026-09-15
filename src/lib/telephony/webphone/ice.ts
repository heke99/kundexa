import "server-only";
import { createHmac } from "node:crypto";
import { serverEnv } from "@/lib/env";

/**
 * Tidsbegränsade TURN-uppgifter, enligt det mönster TURN-servrar själva
 * förväntar sig (`username` = utgångstid, `credential` = HMAC över den med en
 * delad hemlighet).
 *
 * Poängen är att hemligheten aldrig lämnar servern. Webbläsaren får ett
 * användarnamn som slutar gälla och en signatur som inte går att räkna baklänges
 * — hade vi skickat själva TURN-lösenordet hade vem som helst med en felrapport
 * i handen kunnat relaya trafik genom vår server hur länge som helst.
 *
 * Leverantörsoberoende med flit: samma funktion fungerar mot en egen coturn och
 * mot en TURN en telefonileverantör tillhandahåller.
 */
export function mintIceServers(identity: string, ttlSeconds: number) {
  const env = serverEnv();
  const stun = env.WEBPHONE_STUN_URLS;
  const turn = env.WEBPHONE_TURN_URLS;
  const servers: Array<{ urls: string[]; username?: string; credential?: string }> = [];

  if (stun.length) servers.push({ urls: stun });

  if (turn.length && env.WEBPHONE_TURN_SECRET) {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const username = `${expiresAt}:${identity}`;
    const credential = createHmac("sha1", env.WEBPHONE_TURN_SECRET).update(username).digest("base64");
    servers.push({ urls: turn, username, credential });
  }

  return servers;
}

/**
 * Om en webbtelefon skulle klara sig utan TURN. Nästan aldrig i praktiken: utan
 * relä faller ljudet tyst bakom företagsbrandväggar, och "kunden hör mig inte"
 * är en långt värre felrapport än "webbtelefonen vägrade starta".
 */
export function turnConfigured() {
  const env = serverEnv();
  return env.WEBPHONE_TURN_URLS.length > 0 && Boolean(env.WEBPHONE_TURN_SECRET);
}
