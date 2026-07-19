"use client";

import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Radio } from "@/components/icons";

type Customer = {
  id: string;
  display_name: string;
  phone_e164: string | null;
  do_not_call: boolean;
};

type VoiceConfig = {
  clientNumber: string;
  username: string;
  password: string;
  websocketUrl: string;
  domain: string;
};

type SessionLike = {
  answer: (options: object) => void;
  terminate: () => void;
  connection: RTCPeerConnection;
  on: (event: string, handler: () => void) => unknown;
};

type UaLike = {
  start: () => void;
  stop: () => void;
  on: (event: string, handler: (event: unknown) => void) => unknown;
};

type JsSipNamespace = {
  WebSocketInterface: new (url: string) => unknown;
  UA: new (configuration: Record<string, unknown>) => UaLike;
};

declare global {
  interface Window {
    JsSIP?: JsSipNamespace;
    __kundexaJsSipPromise?: Promise<JsSipNamespace>;
  }
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

export function WebRtcDialer({ customers, initialCustomer }: { customers: Customer[]; initialCustomer?: string }) {
  const [selected, setSelected] = useState(initialCustomer ?? "");
  const [status, setStatus] = useState("Ansluter WebRTC…");
  const [registered, setRegistered] = useState(false);
  const [calling, setCalling] = useState(false);
  const sessionRef = useRef<SessionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const requestKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let ua: UaLike | null = null;

    void (async () => {
      try {
        const response = await fetch("/api/v1/voice-client");
        if (!response.ok) {
          setStatus("WebRTC-klient saknas");
          return;
        }

        const config = await response.json() as VoiceConfig;
        const JsSIP = await loadJsSip();
        if (!active) return;

        const socket = new JsSIP.WebSocketInterface(config.websocketUrl);
        const createdUa = new JsSIP.UA({
          sockets: [socket],
          uri: `sip:${config.username}@${config.domain}`,
          password: config.password,
          register: true,
        });
        ua = createdUa;

        createdUa.on("registered", () => {
          setRegistered(true);
          setStatus(`Redo · ${config.clientNumber}`);
        });
        createdUa.on("registrationFailed", () => {
          setRegistered(false);
          setStatus("WebRTC-registrering misslyckades");
        });
        createdUa.on("newRTCSession", (raw) => {
          const event = raw as { session: SessionLike };
          const session = event.session;
          sessionRef.current = session;
          session.answer({ mediaConstraints: { audio: true, video: false } });
          session.connection.addEventListener("track", (trackEvent) => {
            if (audioRef.current) {
              audioRef.current.srcObject = trackEvent.streams[0];
              void audioRef.current.play();
            }
          });
          setCalling(true);
          setStatus("Samtal pågår");
          const ended = () => {
            sessionRef.current = null;
            setCalling(false);
            setStatus("Redo");
          };
          session.on("ended", ended);
          session.on("failed", ended);
        });
        createdUa.start();
      } catch {
        setStatus("WebRTC kunde inte startas");
      }
    })();

    return () => {
      active = false;
      ua?.stop();
    };
  }, []);

  async function call() {
    if (calling) {
      sessionRef.current?.terminate();
      return;
    }
    if (!selected) return;

    setStatus("Köar samtalet…");
    requestKeyRef.current ??= `webrtc.call:${crypto.randomUUID()}`;
    const response = await fetch("/api/v1/calls", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": requestKeyRef.current },
      body: JSON.stringify({ customerId: selected, idempotencyKey: requestKeyRef.current }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      setStatus(data.error ?? "Samtalet kunde inte startas");
      return;
    }
    requestKeyRef.current = null;
    setStatus("Ringer din WebRTC-klient…");
  }

  return (
    <div>
      <audio ref={audioRef} autoPlay />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Kundexa WebRTC</strong>
        <span className={`badge ${registered ? "badge-success" : "badge-warning"}`}>
          <Radio size={12} /> {status}
        </span>
      </div>
      <div className="phone-display">{customers.find((customer) => customer.id === selected)?.phone_e164 ?? "Välj kund"}</div>
      <div className="dialpad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((key) => <button key={key} type="button">{key}</button>)}
      </div>
      <label className="field" style={{ color: "white", marginTop: 18 }}>
        <span>Kund</span>
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Välj kund</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id} disabled={customer.do_not_call}>
              {customer.display_name} · {customer.phone_e164}{customer.do_not_call ? " · SPÄRRAD" : ""}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="call-button" onClick={call} disabled={!registered || !selected} aria-label={calling ? "Lägg på" : "Ring"}>
        {calling ? <PhoneOff size={25} /> : <Phone size={25} />}
      </button>
    </div>
  );
}
