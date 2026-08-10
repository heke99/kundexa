import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { RuntimeDatabase } from "@/lib/supabase/runtime-database.types";

// Surfaces that serve tenant-scoped personal data. Everything under them must be
// unstorable by browsers and shared proxies: without an explicit directive a response
// carries no caching instruction at all, which leaves it up to intermediary heuristics.
// `/api/openapi.json` (a static contract document) and `/api/public` (token-scoped, and
// already sending its own no-store) are deliberately excluded so their own cache policy
// stays authoritative.
function isTenantScopedPath(pathname: string) {
  if (pathname.startsWith("/api/openapi.json") || pathname.startsWith("/api/public")) return false;
  return pathname.startsWith("/app") || pathname.startsWith("/api") || pathname.startsWith("/onboarding") || pathname.startsWith("/change-password");
}

function securityHeaders(response: NextResponse, contentSecurityPolicy: string, tenantScoped: boolean) {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  if (tenantScoped) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    response.headers.set("Vary", "Cookie, Authorization");
  }
  return response;
}

export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const nonce = btoa(crypto.randomUUID());
  const supabaseOrigin = url ? new URL(url).origin : "";
  const supabaseSocket = supabaseOrigin.replace(/^http/, "ws");
  const developmentScriptPolicy = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentScriptPolicy}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseOrigin} ${supabaseSocket}`.trim(),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  const tenantScoped = isTenantScopedPath(request.nextUrl.pathname);
  const requestHeaders = new Headers(request.headers);
  // Always overwrite this internal routing hint so clients cannot spoof which auth
  // context the shared /app layout should require.
  requestHeaders.set("x-kundexa-path", request.nextUrl.pathname);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  let response = securityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), contentSecurityPolicy, tenantScoped);
  if (!url || !key) return response;

  const supabase = createServerClient<RuntimeDatabase>(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = securityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), contentSecurityPolicy, tenantScoped);
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const isApp = request.nextUrl.pathname.startsWith("/app");
  const isAuth = request.nextUrl.pathname.startsWith("/login") || request.nextUrl.pathname.startsWith("/register");

  if (!data.user && isApp) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", request.nextUrl.pathname);
    return securityHeaders(NextResponse.redirect(redirectUrl), contentSecurityPolicy, tenantScoped);
  }
  if (data.user && isAuth) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/app";
    return securityHeaders(NextResponse.redirect(redirectUrl), contentSecurityPolicy, tenantScoped);
  }
  return response;
}
