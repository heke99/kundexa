"use client";

/**
 * Webbtelefonen, utan leverantörens namn.
 *
 * Dialern ska veta att den har en webbtelefon, inte vems. Klientadaptern är den
 * enda filen som får känna leverantörens SDK -- byter vi tjänst skrivs en ny
 * adapter och den här raden pekas om, och dialern rörs inte.
 *
 * Valet är ett import-val och inte ett register, därför att SDK:n laddas
 * dynamiskt i webbläsaren: ett register hade tvingat in varje leverantörs SDK i
 * paketet för att kunna välja mellan dem vid körning.
 */
export { useSinchWebphone as useWebphone } from "./use-sinch-webphone";
export type { WebphoneState } from "./use-sinch-webphone";
