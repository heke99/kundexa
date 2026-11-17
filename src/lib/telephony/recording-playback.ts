/** Only a canonical private object belonging to this exact call may be signed. */
export function recordingPlaybackPath(tenantId: string, callId: string, path: unknown): string {
  if (typeof path !== "string" || !path.startsWith(`${tenantId}/${callId}/`)
    || path.includes("\\") || path.includes("%") || path.includes("?") || path.includes("#")
    || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("recording_storage_scope_invalid");
  }
  return path;
}
