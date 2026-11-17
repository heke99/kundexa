"use client";

import type { IncomingCall } from "@/hooks/use-webphone";

type Props = {
  incoming: IncomingCall | null;
  incomingError: string | null;
  acceptIncoming: () => Promise<void>;
  declineIncoming: () => Promise<void>;
  hangupWebphone: () => void;
  muted: boolean;
  toggleMute: () => unknown;
  audioCapabilities: { mute: boolean };
  audioError: string | null;
  resumeAudio: () => unknown;
};

/** Shared by individual and list dialing, including the embedded contract view. */
export function IncomingCallPanel(props: Props) {
  const call = props.incoming;
  if (!call) return props.incomingError ? <p role="alert" className="form-error">{props.incomingError}</p> : null;
  return <section className="notice" aria-label="Inkommande samtal" aria-live="polite">
    <strong>{call.phase === "answered" ? "Pågående inkommande samtal" : "Inkommande samtal"}</strong>
    <p>{call.from === "anonymous" ? "Skyddat eller okänt nummer" : call.from}</p>
    <div className="toolbar">
      {call.phase === "offered" ? <>
        <button type="button" className="button button-primary" onClick={() => void props.acceptIncoming()}>Svara</button>
        <button type="button" className="button button-secondary" onClick={() => void props.declineIncoming()}>Avvisa</button>
      </> : <>
        {call.phase === "accepting" ? <span>Ansluter samtalet…</span> : null}
        <button type="button" className="button button-secondary" onClick={props.hangupWebphone}>Lägg på</button>
        {call.phase === "answered" && props.audioCapabilities.mute ? <button type="button" className="button button-ghost" aria-pressed={props.muted} onClick={props.toggleMute}>{props.muted ? "Slå på mikrofon" : "Stäng av mikrofon"}</button> : null}
      </>}
    </div>
    {props.audioError ? <p role="alert">{props.audioError} <button type="button" className="button button-sm" onClick={props.resumeAudio}>Aktivera samtalsljud</button></p> : null}
    {props.incomingError ? <p role="alert" className="form-error">{props.incomingError}</p> : null}
  </section>;
}
