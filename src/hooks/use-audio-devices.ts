"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Ljudet före samtalet.
 *
 * En trasig mikrofon upptäcks annars först när kunden säger "hallå?" tre gånger
 * och lägger på. Det här är kontrollen som låter säljaren se att mikrofonen
 * faktiskt fångar ljud, och höra att rätt högtalare låter, innan hon ringer.
 *
 * Strömmen ägs här och bara här. Den öppnas när mätaren startas och stängs när
 * den stoppas -- en kvarglömd `getUserMedia`-ström håller mikrofonlampan tänd
 * och lämnar säljaren med intrycket att hon avlyssnas.
 */

export type AudioDevice = { deviceId: string; label: string };

export type AudioDevicesState = {
  /** Har vi frågat om mikrofonen, och vad blev svaret? */
  permission: "unknown" | "granted" | "denied" | "unsupported";
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  inputId: string;
  outputId: string;
  /** 0–1. Bara meningsfull medan mätaren är igång. */
  level: number;
  metering: boolean;
  /** Webbläsaren kan välja utgång. Safari kan inte, och då ska vi inte påstå det. */
  canChooseOutput: boolean;
  error: string | null;
};

const INPUT_KEY = "kundexa.webphone.inputDeviceId";
const OUTPUT_KEY = "kundexa.webphone.outputDeviceId";

/** localStorage kan kasta i privat läge. En bekvämlighet får inte fälla telefonin. */
function readStored(key: string) {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Valet gäller den här fliken i stället. Inget att rapportera.
  }
}

export function useAudioDevices() {
  const [state, setState] = useState<AudioDevicesState>({
    permission: "unknown",
    inputs: [],
    outputs: [],
    inputId: "",
    outputId: "",
    level: 0,
    metering: false,
    canChooseOutput: false,
    error: null,
  });

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);

  const stopMetering = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => null);
    contextRef.current = null;
    setState((previous) => ({ ...previous, metering: false, level: 0 }));
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setState((previous) => ({ ...previous, permission: "unsupported" }));
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    // Etiketterna är tomma tills mikrofontillstånd getts. En tom etikett är
    // värdelös i en lista, så den får ett ordningsnummer i stället.
    const inputs = devices.filter((device) => device.kind === "audioinput")
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Mikrofon ${index + 1}` }));
    const outputs = devices.filter((device) => device.kind === "audiooutput")
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Högtalare ${index + 1}` }));

    setState((previous) => {
      // Ett sparat val som inte längre finns -- headsetet är urdraget -- får
      // inte bli kvar som en tyst peka-på-ingenting.
      const inputId = inputs.some((device) => device.deviceId === previous.inputId) ? previous.inputId : (inputs[0]?.deviceId ?? "");
      const outputId = outputs.some((device) => device.deviceId === previous.outputId) ? previous.outputId : (outputs[0]?.deviceId ?? "");
      return { ...previous, inputs, outputs, inputId, outputId };
    });
  }, []);

  useEffect(() => {
    const canChooseOutput = typeof window !== "undefined"
      && typeof HTMLMediaElement !== "undefined"
      && "setSinkId" in HTMLMediaElement.prototype;
    setState((previous) => ({
      ...previous,
      canChooseOutput,
      inputId: readStored(INPUT_KEY),
      outputId: readStored(OUTPUT_KEY),
    }));
    void refreshDevices();

    // Ett headset som kopplas in mitt i arbetsdagen ska dyka upp utan omladdning.
    const onChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
    };
  }, [refreshDevices]);

  useEffect(() => stopMetering, [stopMetering]);

  /** Frågar om mikrofonen och fyller listorna med riktiga etiketter. */
  const requestPermission = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState((previous) => ({ ...previous, permission: "unsupported", error: "Webbläsaren kan inte komma åt mikrofonen." }));
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setState((previous) => ({ ...previous, permission: "granted", error: null }));
      await refreshDevices();
      return true;
    } catch (error) {
      // Nekad och "finns ingen mikrofon" är olika problem med olika åtgärd, så
      // de får olika meningar i stället för ett gemensamt "gick inte".
      const name = error instanceof Error ? error.name : "";
      setState((previous) => ({
        ...previous,
        permission: "denied",
        error: name === "NotFoundError" || name === "OverconstrainedError"
          ? "Ingen mikrofon hittades. Koppla in ett headset och försök igen."
          : "Webbläsaren nekar Kundexa att använda mikrofonen. Tillåt den i adressfältets låsikon.",
      }));
      return false;
    }
  }, [refreshDevices]);

  const selectInput = useCallback((deviceId: string) => {
    store(INPUT_KEY, deviceId);
    setState((previous) => ({ ...previous, inputId: deviceId }));
  }, []);

  const selectOutput = useCallback((deviceId: string) => {
    store(OUTPUT_KEY, deviceId);
    setState((previous) => ({ ...previous, outputId: deviceId }));
  }, []);

  /**
   * Nivåmätaren.
   *
   * Öppnar en egen ström mot den valda mikrofonen och visar hur mycket den
   * fångar. Det är hela poängen: en mikrofon som är avstängd i hårdvaran ser
   * likadan ut som en som fungerar, ända tills någon talar i den.
   */
  const startMetering = useCallback(async () => {
    stopMetering();
    if (!navigator.mediaDevices?.getUserMedia) {
      setState((previous) => ({ ...previous, error: "Webbläsaren kan inte komma åt mikrofonen." }));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: state.inputId ? { deviceId: { exact: state.inputId } } : true,
      });
      streamRef.current = stream;
      const context = new AudioContext();
      contextRef.current = context;
      // En AudioContext startar suspenderad tills en användargest släpper den.
      // Anropet sker från ett klick, så den här raden är det som gör mätaren
      // levande i stället för att visa en evig nolla.
      await context.resume().catch(() => null);

      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);

      setState((previous) => ({ ...previous, metering: true, permission: "granted", error: null }));

      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        // RMS, inte toppvärde: ett enstaka knäpp ska inte se ut som tal.
        const rms = Math.sqrt(sum / samples.length);
        setState((previous) => ({ ...previous, level: Math.min(1, rms * 4) }));
        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    } catch {
      setState((previous) => ({
        ...previous,
        permission: "denied",
        error: "Mikrofonen kunde inte öppnas. Kontrollera att ingen annan flik eller app använder den.",
      }));
    }
  }, [state.inputId, stopMetering]);

  /**
   * Spelar en kort ton i den valda utgången.
   *
   * Utan den kan säljaren välja rätt högtalare i listan och ändå ha volymen
   * nere -- valet säger ingenting om att ljudet hörs.
   */
  const testOutput = useCallback(async () => {
    try {
      const context = new AudioContext();
      await context.resume().catch(() => null);
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.15;
      oscillator.connect(gain).connect(destination);

      const element = new Audio();
      element.srcObject = destination.stream;
      const sinkCapable = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (state.outputId && sinkCapable.setSinkId) {
        await sinkCapable.setSinkId(state.outputId).catch(() => null);
      }
      await element.play().catch(() => null);
      oscillator.start();

      window.setTimeout(() => {
        oscillator.stop();
        element.pause();
        element.srcObject = null;
        void context.close().catch(() => null);
      }, 700);
    } catch {
      setState((previous) => ({ ...previous, error: "Testtonen kunde inte spelas i den valda utgången." }));
    }
  }, [state.outputId]);

  return { ...state, requestPermission, refreshDevices, selectInput, selectOutput, startMetering, stopMetering, testOutput };
}
