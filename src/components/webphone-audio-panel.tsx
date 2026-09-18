"use client";

import { useEffect, useState } from "react";
import { useAudioDevices } from "@/hooks/use-audio-devices";
import type { CallAudioCapabilities } from "@/hooks/use-webphone";

/**
 * Ljudkontrollen bredvid dialern.
 *
 * Före samtalet: tillstånd, val av mikrofon och högtalare, och ett prov som
 * visar att mikrofonen faktiskt fångar ljud. Under samtalet: mikrofon av och
 * knappval.
 *
 * Varje knapp här styrs av vad som faktiskt går att göra, inte av vad som vore
 * trevligt. En avstängningsknapp som inte stänger av är hur en säljare säger
 * något till kollegan bredvid rakt in i kundens öra.
 */
export function WebphoneAudioPanel({
  inCall,
  muted,
  capabilities,
  onToggleMute,
  onSendDtmf,
}: {
  inCall: boolean;
  muted: boolean;
  capabilities: CallAudioCapabilities;
  onToggleMute: () => boolean;
  onSendDtmf: (digit: string) => boolean;
}) {
  const audio = useAudioDevices();
  const [dtmfSent, setDtmfSent] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // Mätaren hör till förberedelsen. Att låta den ligga kvar under samtalet
  // håller en andra mikrofonström öppen bredvid den telefonen själv använder.
  useEffect(() => {
    if (inCall && audio.metering) audio.stopMetering();
  }, [inCall, audio]);

  useEffect(() => {
    if (!inCall) setDtmfSent("");
  }, [inCall]);

  return <div className="webphone-audio">
    {audio.permission === "unsupported"
      ? <div className="notice warning">Den här webbläsaren kan inte använda mikrofonen. Använd Chrome, Edge eller Firefox.</div>
      : null}
    {audio.error ? <div className="notice warning">{audio.error}</div> : null}
    {notice ? <div className="notice warning">{notice}</div> : null}

    {audio.permission !== "granted" && audio.permission !== "unsupported"
      ? <div className="notice">
        <p>Kundexa behöver tillgång till mikrofonen för att du ska kunna prata med kunden.</p>
        <button
          type="button"
          className="button button-primary"
          style={{ marginTop: 10 }}
          onClick={() => void audio.requestPermission()}
        >
          Tillåt mikrofonen
        </button>
      </div>
      : null}

    {audio.permission === "granted" ? <>
      <label className="field">
        <span>Mikrofon</span>
        <select value={audio.inputId} onChange={(event) => audio.selectInput(event.target.value)}>
          {audio.inputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </select>
      </label>

      {audio.canChooseOutput
        ? <label className="field">
          <span>Högtalare</span>
          <select value={audio.outputId} onChange={(event) => audio.selectOutput(event.target.value)}>
            {audio.outputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>
        </label>
        // Safari låter inte sidan välja utgång. Att visa en lista som inte gör
        // något vore ett löfte webbläsaren inte kan hålla.
        : <p className="muted">Den här webbläsaren väljer högtalare i systeminställningarna, inte här.</p>}

      {!inCall ? <>
        <div className="toolbar-left" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="button button-secondary button-sm"
            onClick={() => (audio.metering ? audio.stopMetering() : void audio.startMetering())}
          >
            {audio.metering ? "Stoppa mikrofontest" : "Testa mikrofonen"}
          </button>
          <button type="button" className="button button-secondary button-sm" onClick={() => void audio.testOutput()}>
            Spela testton
          </button>
        </div>
        {audio.metering ? <>
          <div className="level-meter" aria-hidden="true">
            <div className="level-meter-fill" style={{ width: `${Math.round(audio.level * 100)}%` }} />
          </div>
          <p className="muted">
            {audio.level > 0.04
              ? "Mikrofonen fångar ljud."
              : "Säg något. Rör sig inget här hör kunden dig inte heller."}
          </p>
        </> : null}
      </> : null}
    </> : null}

    {inCall ? <div className="webphone-in-call">
      {capabilities.mute
        ? <button
          type="button"
          className={`button ${muted ? "button-primary" : "button-secondary"}`}
          onClick={() => { if (!onToggleMute()) setNotice("Mikrofonen kunde inte stängas av för det här samtalet."); }}
        >
          {muted ? "Slå på mikrofonen" : "Stäng av mikrofonen"}
        </button>
        : <p className="muted">Mikrofonen kan inte stängas av under det här samtalet.</p>}

      {capabilities.dtmf ? <div style={{ marginTop: 12 }}>
        <p className="muted">Knappval, för växlar och telefonsvarare.</p>
        <div className="dtmf-pad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit) => (
            <button
              key={digit}
              type="button"
              className="button button-secondary"
              onClick={() => {
                if (onSendDtmf(digit)) setDtmfSent((previous) => (previous + digit).slice(-20));
                else setNotice("Knappvalet kunde inte skickas.");
              }}
            >
              {digit}
            </button>
          ))}
        </div>
        {dtmfSent ? <p className="muted">Skickat: <code>{dtmfSent}</code></p> : null}
      </div> : null}
    </div> : null}
  </div>;
}
