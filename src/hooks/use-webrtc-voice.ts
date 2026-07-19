"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type VoiceConfig = { clientNumber: string; username: string; password: string; websocketUrl: string; domain: string };
type SessionLike = { answer: (options: object) => void; terminate: () => void; connection: RTCPeerConnection; on: (event: string, handler: () => void) => unknown };
type UaLike = { start: () => void; stop: () => void; on: (event: string, handler: (event: unknown) => void) => unknown };
type JsSipNamespace = { WebSocketInterface: new (url: string) => unknown; UA: new (configuration: Record<string, unknown>) => UaLike };

declare global {
  interface Window { JsSIP?: JsSipNamespace; __kundexaJsSipPromise?: Promise<JsSipNamespace> }
}

function loadJsSip(): Promise<JsSipNamespace> {
  if (window.JsSIP) return Promise.resolve(window.JsSIP);
  if (window.__kundexaJsSipPromise) return window.__kundexaJsSipPromise;
  window.__kundexaJsSipPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-kundexa-jssip="true"]');
    const script = existing ?? document.createElement("script");
    script.src = "/vendor/jssip-3.13.8.js";
    script.async = true;
    script.dataset.kundexaJssip = "true";
    script.onload = () => window.JsSIP ? resolve(window.JsSIP) : reject(new Error("JsSIP saknas efter laddning"));
    script.onerror = () => reject(new Error("JsSIP kunde inte laddas"));
    if (!existing) document.head.appendChild(script);
  });
  return window.__kundexaJsSipPromise;
}

export function useWebRtcVoice(onEnded?: () => void) {
  const [registered, setRegistered] = useState(false);
  const [calling, setCalling] = useState(false);
  const [status, setStatus] = useState("Ansluter WebRTC…");
  const sessionRef = useRef<SessionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    let active = true;
    let userAgent: UaLike | null = null;
    void (async () => {
      try {
        const response = await fetch("/api/v1/voice-client");
        if (!response.ok) { setStatus("WebRTC-klient saknas"); return; }
        const config = await response.json() as VoiceConfig;
        const JsSIP = await loadJsSip();
        if (!active) return;
        const socket = new JsSIP.WebSocketInterface(config.websocketUrl);
        userAgent = new JsSIP.UA({ sockets: [socket], uri: `sip:${config.username}@${config.domain}`, password: config.password, register: true });
        userAgent.on("registered", () => { setRegistered(true); setStatus(`Redo · ${config.clientNumber}`); });
        userAgent.on("registrationFailed", () => { setRegistered(false); setStatus("WebRTC-registrering misslyckades"); });
        userAgent.on("newRTCSession", (raw) => {
          const session = (raw as { session: SessionLike }).session;
          sessionRef.current = session;
          session.answer({ mediaConstraints: { audio: true, video: false } });
          session.connection.addEventListener("track", (event) => {
            if (audioRef.current) { audioRef.current.srcObject = event.streams[0]; void audioRef.current.play(); }
          });
          setCalling(true);
          setStatus("Samtal pågår");
          const ended = () => {
            sessionRef.current = null;
            setCalling(false);
            setStatus("Redo");
            onEndedRef.current?.();
          };
          session.on("ended", ended);
          session.on("failed", ended);
        });
        userAgent.start();
      } catch { setStatus("WebRTC kunde inte startas"); }
    })();
    return () => { active = false; userAgent?.stop(); };
  }, []);

  const startCall = useCallback(async (payload: Record<string, unknown>) => {
    setStatus("Köar samtalet…");
    const response = await fetch("/api/v1/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json() as { callId?: string; error?: string };
    if (!response.ok || !data.callId) { setStatus(data.error ?? "Samtalet kunde inte startas"); throw new Error(data.error ?? "call_start_failed"); }
    setStatus("Ringer din WebRTC-klient…");
    return data.callId;
  }, []);

  const hangup = useCallback(() => sessionRef.current?.terminate(), []);
  return { audioRef, registered, calling, status, startCall, hangup };
}
