"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

const terminalStatuses = new Set(["completed", "busy", "no_answer", "failed", "cancelled"]);

export function useCallRealtime(callId: string | null, onTerminal: (status: string) => void) {
  const handler = useRef(onTerminal);
  handler.current = onTerminal;
  useEffect(() => {
    if (!callId) return;
    const supabase = createClient();
    const channel = supabase.channel(`call:${callId}`).on("postgres_changes", {
      event: "UPDATE", schema: "public", table: "calls", filter: `id=eq.${callId}`,
    }, (payload) => {
      const status = String((payload.new as { status?: string }).status ?? "");
      if (terminalStatuses.has(status)) handler.current(status);
    }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [callId]);
}
