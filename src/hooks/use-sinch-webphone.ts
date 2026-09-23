"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Säljarens webbtelefon.
 *
 * Samtalet kopplas här, i webbläsaren, och inte av servern. Servern reserverar
 * platsen och delar ut en kortlivad JWT; `sinch-rtc` sköter signalering, media
 * och ICE. Ingen enhet att registrera, inget konto hos leverantören, ingen
 * telefon som ringer först och kopplar vidare.
 *
 * SDK:t laddas dynamiskt. Det rör `window`, `navigator.mediaDevices` och
 * RTCPeerConnection vid import, och skulle krascha en serverrendering.
 */

export type WebphoneState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "ready" }
  | { phase: "calling"; callId: string }
  | { phase: "unavailable"; code: string; message: string };

type SinchCredentials = {
  kind: string;
  applicationKey: string;
  userId: string;
  environmentHost: string;
  token: string;
  callerIdentifier: string;
  expiresAt: string;
};

type LegEvent = "ringing" | "answered" | "ended";

/**
 * Vad det pågående samtalet faktiskt går att göra.
 *
 * Kontrollerat på samtalsobjektet, inte antaget. En knapp som ser ut att stänga
 * av mikrofonen men inte gör det är värre än ingen knapp: säljaren tror att
 * kunden inte hör henne.
 */
export type CallAudioCapabilities = { mute: boolean; dtmf: boolean };

type ProviderCall = {
  id: string;
  hangup: () => void;
  addListener: (listener: unknown) => void;
  mute?: () => void;
  unmute?: () => void;
  setMuted?: (muted: boolean) => void;
  sendDTMF?: (digit: string) => void;
  details?: { endCause?: number; error?: { message?: string; code?: unknown } };
};

// Leverantörens avslutsorsak, i den ordning SDK:t numrerar dem (`CallEndCause`).
const END_CAUSES = ["None", "Timeout", "Denied", "NoAnswer", "Failure", "HungUp", "Canceled", "OtherDeviceAnswered", "Inactive"];

/**
 * Mikrofonen öppnas en gång och återanvänds.
 *
 * SDK:t bad om en ny ström vid varje samtal och stängde den efteråt. I Safari
 * och Firefox betydde det en behörighetsfråga per samtal, och i alla
 * webbläsare en halv sekund innan säljaren hördes. Här hålls en ström öppen för
 * sessionen och varje samtal får en kopia: SDK:t stänger kopian när samtalet
 * slutar, originalet lever vidare. Byts mikrofon (andra villkor) hämtas en ny.
 */
function createReusableMicrophone() {
  let master: MediaStream | null = null;
  let masterKey = "";
  const alive = (stream: MediaStream | null) => Boolean(stream?.getAudioTracks().some((track) => track.readyState === "live"));
  return {
    async getMediaStream(options: { audio?: boolean | MediaTrackConstraints; video?: boolean | MediaTrackConstraints }) {
      if (options.video) {
        return navigator.mediaDevices.getUserMedia({ audio: options.audio ?? true, video: options.video });
      }
      const audio = options.audio ?? true;
      const key = JSON.stringify(audio);
      if (!alive(master) || key !== masterKey) {
        master?.getTracks().forEach((track) => track.stop());
        master = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        masterKey = key;
      }
      return master!.clone();
    },
    release() {
      master?.getTracks().forEach((track) => track.stop());
      master = null;
    },
  };
}

function describeEnd(call: ProviderCall | undefined) {
  const cause = call?.details?.endCause;
  const name = typeof cause === "number" ? END_CAUSES[cause] ?? `cause_${cause}` : "unknown";
  const message = call?.details?.error?.message;
  return `${name}${message ? `: ${message}` : ""}`.slice(0, 300);
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, data };
}

export function useSinchWebphone() {
  const [state, setState] = useState<WebphoneState>({ phase: "idle" });
  const clientRef = useRef<unknown>(null);
  const sessionRef = useRef<string | null>(null);
  const callRef = useRef<ProviderCall | null>(null);
  const [muted, setMutedState] = useState(false);
  const [capabilities, setCapabilities] = useState<CallAudioCapabilities>({ mute: false, dtmf: false });
  // Registreringen startas en gång. Utan den här spärren bygger en omrendering
  // en andra klient mot samma användare, och den första tappar sin plats utan
  // att någon får veta.
  const startedRef = useRef(false);
  /**
   * Har klienten faktiskt registrerat sig?
   *
   * `startedRef` betyder bara att uppstarten är påbörjad. Den här säger att
   * leverantören har svarat ja. Skillnaden är inte akademisk: en klient som
   * byggts men aldrig registrerats har ändå ett `callClient`-objekt, så en
   * kontroll av att objektet finns släpper igenom ett samtal som sedan avvisas
   * med "Invalid operation" -- ett fel som pekar på samtalet när problemet är
   * registreringen.
   */
  const registeredRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const microphoneRef = useRef<ReturnType<typeof createReusableMicrophone> | null>(null);

  /**
   * Hjärtslaget som håller sessionen vid liv.
   *
   * `release_lost_webphone_sessions` stänger varje session som varit tyst i fem
   * minuter och markerar samtalet som misslyckat. Rutten och databasfunktionen
   * fanns, men ingenting i klienten anropade dem -- så varje session tystnade
   * direkt och sopades bort medan säljaren satt kvar med fliken öppen. Ett
   * samtal som pågick över gränsen fick sin samtalsrad stämplad `failed` med
   * `webphone_session_lost` medan samtalet fortfarande pågick.
   *
   * Det är också det enda som flyttar sessionen från `registering` till
   * `registered`, och bara när ett registrerings-id följer med. Därför skickas
   * identiteten vi faktiskt registrerade oss med vid första slaget.
   */
  const beat = useCallback(async (registrationId?: string) => {
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    const result = await postJson("/api/v1/telephony/webphone/heartbeat", {
      sessionId, registrationId: registrationId ?? null,
    }).catch(() => null);
    // `alive: false` betyder att sessionen är stängd eller bortsopad. Att fortsätta
    // slå mot den vore att låtsas vara registrerad; säljaren ska ladda om i stället.
    if (result?.ok && result.data && result.data.alive === false) {
      registeredRef.current = false;
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      setState({
        phase: "unavailable",
        code: "webphone_session_lost",
        message: "Webbtelefonens anslutning tappades. Ladda om sidan för att registrera om den.",
      });
    }
  }, []);

  const reportLeg = useCallback(async (callId: string, event: LegEvent, detail?: string) => {
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    // Klientens rapport är en komplettering, inte sanningen. Providerns webhook
    // äger utfallet; det här är bara för att gränssnittet ska hinna med.
    await postJson("/api/v1/telephony/webphone/leg", {
      callId, sessionId, event, occurredAt: new Date().toISOString(), detail: detail ?? null,
    }).catch(() => null);
  }, []);

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setState({ phase: "starting" });

    const opened = await postJson("/api/v1/telephony/webphone/session", {
      userAgent: navigator.userAgent.slice(0, 400),
    });
    if (!opened.ok || !opened.data) {
      startedRef.current = false;
      setState({
        phase: "unavailable",
        code: String(opened.data?.error ?? "webphone_session_failed"),
        message: String(opened.data?.message ?? "Webbtelefonen kunde inte startas."),
      });
      return;
    }

    const credentials = opened.data.credentials as SinchCredentials | undefined;
    if (!credentials || credentials.kind !== "sinch_rtc") {
      startedRef.current = false;
      setState({
        phase: "unavailable",
        code: "webphone_credentials_unsupported",
        message: "Webbtelefonen fick uppgifter i ett format den inte kan använda.",
      });
      return;
    }
    sessionRef.current = String(opened.data.sessionId ?? "");

    // SDK:t sväljer orsaken när registreringen misslyckas: det fångar felet,
    // skriver det i konsolen och rapporterar bara "Unable to create instance!".
    // Nio sessioner registrerades aldrig utan att en enda rad sa varför. Därför
    // går SDK:ts anrop genom den här, som minns leverantörens senaste nej.
    let lastProviderRefusal: string | null = null;
    const observedFetch = async (input: RequestInfo, init?: RequestInit) => {
      try {
        const response = await fetch(input, init);
        if (!response.ok) {
          const body = await response.clone().text().catch(() => "");
          const path = (typeof input === "string" ? input : input.url).replace(/^https?:\/\/[^/]+/, "").replace(/applications\/[^/]+/, "applications/…");
          lastProviderRefusal = `HTTP ${response.status} ${path} ${body.replace(/\s+/g, " ").slice(0, 120)}`.trim();
        }
        return response;
      } catch (error) {
        lastProviderRefusal = `network ${error instanceof Error ? error.message : "error"}`.slice(0, 160);
        throw error;
      }
    };
    // Felet sparas på sessionen, där det går att läsa utan att någon behöver
    // öppna webbläsarens konsol.
    const reportFailure = (code: string, detail: string) => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      void fetch("/api/v1/telephony/webphone/session", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, reason: `${code}: ${detail}`.slice(0, 200) }),
      }).catch(() => null);
    };

    try {
      const { Sinch } = await import("sinch-rtc");
      const client = Sinch.getSinchClientBuilder()
        .applicationKey(credentials.applicationKey)
        .userId(credentials.userId)
        .environmentHost(credentials.environmentHost)
        // Utan CLI får samtalet ett id från Sinch och når aldrig mottagaren.
        // Servern vägrar dela ut uppgifter utan det, så här kan det bara saknas
        // om kontraktet brutits -- men det sätts uttryckligen ändå.
        .callerIdentifier(credentials.callerIdentifier)
        .fetchApi(observedFetch)
        .mediaStreamFactory((microphoneRef.current ??= createReusableMicrophone()))
        .build();

      client.addListener({
        onCredentialsRequired: (_c: unknown, registration: { register: (t: string) => void; registerFailed: () => void }) => {
          // Första gången räcker den token vi redan har. Därefter hämtas en ny,
          // eftersom den vi fick är kortlivad med flit.
          if (Date.parse(credentials.expiresAt) > Date.now() + 30_000) {
            registration.register(credentials.token);
            return;
          }
          void postJson("/api/v1/telephony/webphone/session", { userAgent: navigator.userAgent.slice(0, 400) })
            .then((refreshed) => {
              // Förnyelsen öppnar en ny session och stänger den gamla. Utan
              // det här slog hjärtslaget vidare mot den stängda, fick
              // `alive: false` och sa åt säljaren att ladda om.
              if (refreshed.data?.sessionId) sessionRef.current = String(refreshed.data.sessionId);
              const next = refreshed.data?.credentials as SinchCredentials | undefined;
              if (next?.token) registration.register(next.token);
              else registration.registerFailed();
            })
            .catch(() => registration.registerFailed());
        },
        onClientStarted: () => {
          registeredRef.current = true;
          setState({ phase: "ready" });
          // Första slaget bär registrerings-id:t, som är det enda som flyttar
          // sessionen till `registered`. Intervallet är satt med god marginal
          // till sopningens fem minuter: ett tappat slag får inte räcka.
          void beat(credentials.userId);
          if (heartbeatRef.current) clearInterval(heartbeatRef.current);
          heartbeatRef.current = setInterval(() => { void beat(); }, 30_000);
        },
        onClientFailed: (_c: unknown, error: unknown) => {
          startedRef.current = false;
          registeredRef.current = false;
          if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
          const reason = lastProviderRefusal
            ?? (error instanceof Error ? error.message : typeof error === "string" ? error : "unknown");
          console.error("webphone_client_failed", { reason });
          reportFailure("webphone_client_failed", reason);
          setState({
            phase: "unavailable",
            code: "webphone_registration_failed",
            message: "Webbtelefonen kunde inte registrera sig. Ladda om sidan och försök igen.",
          });
        },
      });
      client.start();
      clientRef.current = client;
    } catch (error) {
      startedRef.current = false;
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
      console.error("webphone_sdk_load_failed", { reason });
      reportFailure("webphone_sdk_load_failed", reason);
      setState({
        phase: "unavailable",
        code: "webphone_sdk_unavailable",
        message: "Webbtelefonen kunde inte laddas i den här webbläsaren.",
      });
    }
  }, [beat]);

  /**
   * Ringer ett redan reserverat samtal.
   *
   * Reservationen har skett på servern; `callId` och `attemptId` kommer därifrån.
   * Utfallet rapporteras tillbaka i alla tre riktningarna -- accepterat, misslyckat
   * och okänt -- eftersom ett samtal som startade men vars svar tappades kan ringa
   * hos mottagaren just nu, och att stänga det som misslyckat skulle släppa
   * platsen mitt i det.
   */
  const placeCall = useCallback(async (input: { callId: string; attemptId: string; to: string }) => {
    const client = clientRef.current as { callClient?: { callPhoneNumber: (n: string) => Promise<unknown> } } | null;
    // Registreringen måste vara klar, inte bara påbörjad. Se `registeredRef`.
    if (!client?.callClient || !registeredRef.current) {
      await postJson("/api/v1/calls/dialing", {
        callId: input.callId, attemptId: input.attemptId, outcome: "failed",
        errorCode: "webphone_not_ready", errorMessage: "Webbtelefonen var inte registrerad hos leverantören.",
      });
      throw new Error("webphone_not_ready");
    }

    let call: ProviderCall;
    try {
      call = await client.callClient.callPhoneNumber(input.to) as ProviderCall;
    } catch (error) {
      await postJson("/api/v1/calls/dialing", {
        callId: input.callId, attemptId: input.attemptId, outcome: "failed",
        errorCode: "webphone_dial_rejected",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Samtalet avvisades.",
      });
      throw error;
    }

    // Lyssnaren kopplas på innan något annat väntas in. Den låg efter
    // rapporten till servern, och ett samtal som hann ringa eller brytas under
    // den väntan lämnade inga spår: dialern stod kvar på "ringer" och det gick
    // inte att se varför.
    call.addListener({
      onCallRinging: () => void reportLeg(input.callId, "ringing"),
      onCallAnswered: () => void reportLeg(input.callId, "answered"),
      onCallEstablished: () => void reportLeg(input.callId, "answered"),
      onCallEnded: (ended: ProviderCall) => {
        callRef.current = null;
        setMutedState(false);
        setCapabilities({ mute: false, dtmf: false });
        setState({ phase: "ready" });
        void reportLeg(input.callId, "ended", describeEnd(ended));
      },
    });
    callRef.current = call;
    setMutedState(false);
    setCapabilities({
      mute: typeof call.setMuted === "function" || (typeof call.mute === "function" && typeof call.unmute === "function"),
      dtmf: typeof call.sendDTMF === "function",
    });
    setState({ phase: "calling", callId: input.callId });

    // Samtalets identitet hos leverantören. Utan den går inkommande ace och dice
    // inte att koppla till det här försöket, så den rapporteras före allt annat.
    const reported = await postJson("/api/v1/calls/dialing", {
      callId: input.callId, attemptId: input.attemptId,
      outcome: "accepted", externalCallId: call.id,
    });
    if (!reported.ok) {
      console.error("webphone_dialing_report_failed", { status: reported.status });
    }


    return { providerCallId: call.id };
  }, [reportLeg]);

  /** Lägger på. Samtalet ligger i webbläsaren, så knappen avslutar det på riktigt. */
  const hangup = useCallback(() => {
    callRef.current?.hangup();
  }, []);

  /**
   * Stänger av mikrofonen mot kunden.
   *
   * Tillståndet sätts först när anropet gått igenom. Att sätta det i förväg och
   * hoppas hade visat "mikrofonen av" för en säljare som fortfarande hörs.
   */
  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return false;
    const next = !muted;
    if (typeof call.setMuted === "function") call.setMuted(next);
    else if (next && typeof call.mute === "function") call.mute();
    else if (!next && typeof call.unmute === "function") call.unmute();
    else return false;
    setMutedState(next);
    return true;
  }, [muted]);

  /**
   * Knappval under samtalet, för växlar och telefonsvarare.
   *
   * Returnerar false när leverantörens klient inte kan skicka tonen, så att
   * gränssnittet kan säga det i stället för att låtsas att den gick fram.
   */
  const sendDtmf = useCallback((digit: string) => {
    const call = callRef.current;
    if (!call || typeof call.sendDTMF !== "function") return false;
    if (!/^[0-9*#]$/.test(digit)) return false;
    call.sendDTMF(digit);
    return true;
  }, []);

  useEffect(() => () => {
    // Fliken stängs. Släpp samtalet och sessionen, annars håller platsen kvar
    // säljaren tills sopningen tar den en och en halv minut senare.
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    callRef.current?.hangup();
    // Mikrofonen stängs när dialern lämnas, så att lampan inte lyser kvar.
    microphoneRef.current?.release();
    const sessionId = sessionRef.current;
    if (sessionId) {
      void fetch("/api/v1/telephony/webphone/session", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, reason: "Fliken stängdes" }),
        keepalive: true,
      }).catch(() => null);
    }
  }, []);

  // Sessionen samtalet ringer från. Reservationen måste bära den: annars
  // kopplas försöket aldrig till sessionen, och en flik som stängs eller laddas
  // om mitt i ett samtal lämnar säljaren låst tills städningen tar försöket,
  // tidigast efter en kvart.
  const currentSessionId = useCallback(() => sessionRef.current, []);

  return {
    state, start, placeCall, hangup, toggleMute, sendDtmf, muted, capabilities,
    providerCallId: callRef.current?.id ?? null,
    currentSessionId,
  };
}
