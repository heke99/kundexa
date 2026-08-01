"use client";

import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import type { RuntimeDatabase } from "@/lib/supabase/runtime-database.types";

export function createClient() {
  const env = publicEnv();
  return createBrowserClient<RuntimeDatabase>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
