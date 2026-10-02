/**
 * Shared HTTP helpers for the Depot Manager edge functions.
 * Responses use the same envelope as the Express API: success payloads keep
 * their natural shape, failures are { error: { message } }.
 */

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
  // PUT/DELETE are used by the `api` function's admin and account routes.
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

/** Error carrying an HTTP status; mapped to a JSON response at the router. */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function fail(message: string, status = 400): Response {
  return json({ error: { message } }, status);
}

/** Answers CORS preflight requests; returns null for normal requests. */
export function handleOptions(req: Request): Response | null {
  if (req.method.toUpperCase() === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}

/**
 * The deployed path looks like /functions/v1/<name>/... — strip everything up
 * to and including the function name so routers can match on /cash-sales etc.
 */
export function routePath(pathname: string, functionName: string): string {
  const parts = pathname.split('/').filter(Boolean);
  const idx = parts.indexOf(functionName);
  const rest = idx >= 0 ? parts.slice(idx + 1) : parts;
  return '/' + rest.join('/');
}
