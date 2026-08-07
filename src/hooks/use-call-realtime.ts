"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const terminalStatuses = new Set([
  "completed",
  "busy",
  "no_answer",
  "unanswered",
  "voicemail",
  "failed",
  "cancelled",
  "blocked",
  "outside_business_hours",
]);

const recoveryStatuses = new Set(["provider_outcome_unknown", "reconciliation_required"]);

type ConnectionState = "idle" | "connecting" | "subscribed" | "degraded";

// Polling exists as a safety net for realtime, not as the primary transport. While the
// channel is subscribed it only needs to catch an update the socket silently dropped, so it
// runs rarely; it tightens to a real poll interval only once realtime is degraded.
// The session API budget is 120 requests/minute per user (see lib/api-auth), and a dialer
// sits open for a whole shift — polling every 2.5s regardless of channel health spent a
// fifth of that budget on requests whose answer had already arrived over the socket.
const HEALTHY_POLL_MS = 30_000;
const DEGRADED_POLL_MS = 2_500;

export function useCallRealtime(callId: string | null, onTerminal: (status: string) => void) {
  const handler = useRef(onTerminal);
  const terminalHandled = useRef<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  // Mirrors connectionState so the poll scheduler, which runs outside React's render
  // cycle, can read the current channel health without being re-created on every change.
  const connectionRef = useRef<ConnectionState>("idle");
  handler.current = onTerminal;

  useEffect(() => {
    terminalHandled.current = null;
    setStatus(null);
    if (!callId) {
      connectionRef.current = "idle";
      setConnectionState("idle");
      return;
    }

    const activeCallId = callId;
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // Health changes must retune the poll cadence immediately, otherwise a pending timer
    // keeps the old interval for one more tick — which on a drop means up to 30s of silence.
    function updateConnectionState(next: ConnectionState) {
      const changed = connectionRef.current !== next;
      connectionRef.current = next;
      setConnectionState(next);
      if (changed && active && terminalHandled.current !== activeCallId) schedulePoll();
    }

    function applyStatus(nextStatus: string) {
      if (!active || !nextStatus) return;
      setStatus(nextStatus);
      if (terminalStatuses.has(nextStatus) && terminalHandled.current !== activeCallId) {
        terminalHandled.current = activeCallId;
        handler.current(nextStatus);
      }
    }

    async function fetchCurrentStatus() {
      try {
        const response = await fetch(`/api/v1/calls?id=${encodeURIComponent(activeCallId)}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("call_status_fetch_failed");
        const payload = await response.json() as { data?: { status?: string } | null };
        applyStatus(String(payload.data?.status ?? ""));
      } catch {
        if (active && connectionRef.current !== "subscribed") updateConnectionState("degraded");
      }
    }

    function pollDelay() {
      return connectionRef.current === "subscribed" ? HEALTHY_POLL_MS : DEGRADED_POLL_MS;
    }

    function schedulePoll(delay = pollDelay()) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => {
        await fetchCurrentStatus();
        if (active && terminalHandled.current !== activeCallId) schedulePoll();
      }, delay);
    }

    function scheduleReconnect(delay = 5_000) {
      if (!active || terminalHandled.current === activeCallId || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectRealtime();
      }, delay);
    }

    function connectRealtime() {
      if (!active || terminalHandled.current === activeCallId) return;
      if (channel) void supabase.removeChannel(channel);
      updateConnectionState("connecting");
      channel = supabase.channel(`call:${activeCallId}`).on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "calls",
        filter: `id=eq.${activeCallId}`,
      }, (payload) => {
        applyStatus(String((payload.new as { status?: string }).status ?? ""));
      }).subscribe((channelStatus) => {
        if (!active) return;
        if (channelStatus === "SUBSCRIBED") {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = null;
          updateConnectionState("subscribed");
          void fetchCurrentStatus();
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(channelStatus)) {
          updateConnectionState("degraded");
          void fetchCurrentStatus();
          scheduleReconnect();
        }
      });
    }

    connectRealtime();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void fetchCurrentStatus();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void fetchCurrentStatus();
    schedulePoll();

    return () => {
      active = false;
      if (pollTimer) clearTimeout(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [callId]);

  return {
    status,
    connectionState,
    recovering: status ? recoveryStatuses.has(status) : false,
  };
}
