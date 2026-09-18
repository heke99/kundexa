import "server-only";

/**
 * Att skaffa ett nummer, utan leverantörens vokabulär.
 *
 * Numren köptes tidigare i leverantörens kontrollpanel och skrevs in för hand i
 * `phone_numbers`. Det fungerar, men det betyder att den som ska starta ett nytt
 * företag måste lämna produkten -- och att numret kan skrivas fel.
 *
 * Porten är smal med flit. Den kan söka och hyra. Att säga upp ett nummer är
 * medvetet inte med: det är ett beslut med uppsägningstid och fakturaföljd, och
 * ett API-anrop bakom en knapp är fel ställe att fatta det på.
 */

export type NumberCapability = "voice" | "sms";

export type NumberSearchQuery = {
  /** ISO 3166-1 alpha-2, t.ex. "SE". */
  regionCode: string;
  /** "LOCAL", "MOBILE" eller "TOLL_FREE". */
  numberType: string;
  /** Siffror numret ska innehålla. Tomt betyder vad som helst. */
  pattern?: string;
  limit?: number;
};

export type AvailableNumber = {
  phoneNumber: string;
  regionCode: string;
  numberType: string;
  capabilities: NumberCapability[];
  /** Pris per månad i leverantörens valuta, när det rapporteras. Aldrig gissat. */
  monthlyPrice: { amount: string; currency: string } | null;
  setupPrice: { amount: string; currency: string } | null;
  /**
   * Numret kräver kompletterande dokumentation för att få hyras.
   *
   * Sådana nummer går inte att hyra med ett anrop -- de kräver leverantörens
   * beställningsflöde med identitetskontroll. Att visa dem som "hyr" hade gett
   * en knapp som alltid misslyckas.
   */
  documentationRequired: boolean;
};

export type RentedNumber = {
  phoneNumber: string;
  capabilities: NumberCapability[];
};

export type NumberProvider = {
  readonly id: string;
  isConfigured(): boolean;
  search(query: NumberSearchQuery): Promise<AvailableNumber[]>;
  /**
   * Äger vi redan numret?
   *
   * Finns för att hyrningen är debiterbar. Ett anrop vars svar tappades kan ha
   * lyckats, och det enda säkra sättet att veta är att fråga -- inte att hyra
   * en gång till och hoppas.
   */
  findActive(phoneNumber: string): Promise<RentedNumber | null>;
  /**
   * Hyr numret. Ett anrop, en faktura: den som anropar får inte köra om blint,
   * och adaptern får inte göra ett andra försök på egen hand.
   */
  rent(phoneNumber: string): Promise<RentedNumber>;
};

/** Leverantören svarade med något vi inte kan tolka. */
export class NumberProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NumberProviderError";
  }
}
