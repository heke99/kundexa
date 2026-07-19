"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function RealtimeRefresh() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (pathname.startsWith("/app/dialer/lists/")) return;
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 350);
    };
    let channel = supabase.channel(`workspace:${pathname}`);
    for (const table of ["calls", "activities", "customer_list_members", "customer_lists", "sales_orders"] as const) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, refresh);
    }
    channel.subscribe();
    return () => { if (timer) clearTimeout(timer); void supabase.removeChannel(channel); };
  }, [pathname, router]);
  return null;
}
