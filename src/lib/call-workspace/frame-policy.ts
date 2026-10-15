/** Only the authenticated contract workspace may be framed by this app itself. */
export function isContractWorkspacePath(pathname: string): boolean {
  return pathname === "/app/contracts" || pathname.startsWith("/app/contracts/");
}

export function contractFrameAncestors(pathname: string): string {
  return (isContractWorkspacePath(pathname) || /^\/api\/v1\/contracts\/[^/]+\/documents\/[^/]+$/.test(pathname)) ? "frame-ancestors 'self'" : "frame-ancestors 'none'";
}
