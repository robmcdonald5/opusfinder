import type { CtlConfig } from "./config";

/**
 * The control API client. Presents the Access service token as `CF-Access-Client-Id` /
 * `CF-Access-Client-Secret`; Access swaps it for a signed application token before the Worker sees the
 * request, and the Worker maps the token's client id to the agent role. Redirects are NOT followed: an
 * Access redirect means the token was refused (Access sends unauthenticated callers to its login page),
 * and following it would only produce a confusing HTML page.
 */

export class CtlError extends Error {
  constructor(
    message: string,
    /** The API's error code, when the Worker answered with one. */
    readonly code?: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "CtlError";
  }
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function callApi(
  config: CtlConfig,
  fetchFn: FetchLike,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "cf-access-client-id": config.clientId,
    "cf-access-client-secret": config.clientSecret,
    "x-opusfinder-client": "ctl",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetchFn(`${config.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  } catch (err) {
    // The URL is not a secret; the headers (which hold one) are never part of a fetch error message.
    throw new CtlError(
      `could not reach ${config.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new CtlError(
      `Cloudflare Access refused the service token (HTTP ${res.status} redirect to login). Check clientId/clientSecret ` +
        `and that the Access application has a Service Auth policy including this token.`,
      "access_redirect",
      res.status,
    );
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    await res.body?.cancel();
    throw new CtlError(
      `unexpected HTTP ${res.status} response (${type || "no content type"}) — likely Cloudflare Access, not the control Worker`,
      "not_json",
      res.status,
    );
  }
  return { status: res.status, body: await res.json() };
}

/** The `{ error: { code, message } }` envelope every non-2xx control API response carries. */
export function apiError(res: ApiResponse): CtlError {
  const err = (res.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof err?.code === "string" ? err.code : "error";
  const message = typeof err?.message === "string" ? err.message : `HTTP ${res.status}`;
  return new CtlError(message, code, res.status, res.body);
}
