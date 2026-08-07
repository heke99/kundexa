"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// `router.refresh()` re-runs the whole server render for the current route. These five
// tables are the busiest in the product — every seller's dial writes `calls` several times
// per call, and each write reaches every colleague subscribed here. Debouncing alone only
// collapses events that land inside one window, so a steady stream of activity refreshed
// continuously: a tenant with twenty sellers dialing kept every open page re-rendering.
//
// So the trailing debounce is kept for bursts, and a floor is put under the interval
// between two refreshes for sustained load. Hidden tabs do not refresh at all; a tab that
// missed events while hidden refreshes once when it comes back into view.
const REFRESH_DEBOUNCE_MS = 350;
const MIN_REFRESH_INTERVAL_MS = 3_000;

export function RealtimeRefresh() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (pathname.startsWith("/app/dialer/lists/")) return;
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = 0;
    let pending = false;

    const runRefresh = () => {
      timer = null;
      // A hidden tab keeps the request queued rather than paying for a render nobody sees.
      if (document.visibilityState !== "visible") {
        pending = true;
        return;
      }
      pending = false;
      lastRefreshAt = Date.now();
      router.refresh();
    };

    const refresh = () => {
      pending = true;
      if (timer) clearTimeout(timer);
      const sinceLast = Date.now() - lastRefreshAt;
      const wait = Math.max(REFRESH_DEBOUNCE_MS, MIN_REFRESH_INTERVAL_MS - sinceLast);
      timer = setTimeout(runRefresh, wait);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && pending) refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    let channel = supabase.channel(`workspace:${pathname}`);
    for (const table of ["calls", "activities", "customer_list_members", "customer_lists", "sales_orders"] as const) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, refresh);
    }
    channel.subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void supabase.removeChannel(channel);
    };
  }, [pathname, router]);
  return null;
}
