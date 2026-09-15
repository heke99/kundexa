import "server-only";
import type { WebphoneProvider } from "./provider";

/**
 * Rinkel kan i dag inte bära en webbtelefon, och adaptern säger det rakt ut.
 *
 * Deras publicerade API har tolv kategorier — Audio, Call Detail Records, Call
 * Recordings, Dial, Misc, Music on Hold, Numbers, Privacy, Recordings, Users,
 * Voicemails, Webhooks. Ingen av dem är SIP, enheter eller WebRTC. `POST /dial`
 * med ett `deviceId` är enda sättet att starta ett samtal, och det finns ingen
 * endpoint för att lägga på.
 *
 * Det betyder att webbläsaren inte kan registrera sig som en enhet hos dem, och
 * att `/dial` måste ringa upp en befintlig telefon först — vilket är precis det
 * beteende webbtelefonen finns till för att bli av med.
 *
 * Adaptern finns ändå, och returnerar ett nej med orsak i stället för att
 * saknas. Ett saknat fall blir ett kryptiskt fel någon annanstans; ett uttalat
 * nej blir en mening säljaren kan läsa. Dagen Rinkel svarar på förfrågan i
 * `docs/integrations/RINKEL_WEBPHONE_FORFRAGAN.md` är det den här filen som
 * byts ut, och ingenting annat.
 */
export const rinkelWebphoneProvider: WebphoneProvider = {
  key: "rinkel",
  async provision() {
    return {
      available: false,
      code: "webphone_not_supported_by_provider",
      message:
        "Telefonitjänsten erbjuder ingen webbtelefon. Samtalet måste därför ringa upp en telefon "
        + "först. Administratören behöver begära SIP-uppgifter från telefonitjänsten, eller flytta "
        + "utgående samtal till en tjänst som stöder webbtelefon.",
    };
  },
};
