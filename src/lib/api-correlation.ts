const safeReference = /^[A-Za-z0-9._:-]{8,120}$/;

export function getCorrelationId(request: Request) {
  const supplied = request.headers.get("x-correlation-id") ?? request.headers.get("x-request-id");
  return supplied && safeReference.test(supplied) ? supplied : crypto.randomUUID();
}

export function apiJson(correlationId: string, body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("x-correlation-id", correlationId);
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function withCorrelation(response: Response, correlationId: string) {
  const headers = new Headers(response.headers);
  headers.set("x-correlation-id", correlationId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
