import { adminUrl } from "./adminBase";

export class ApiError extends Error {
  payload: unknown;
  status: number;
  constructor(message: string, payload: unknown, status: number) {
    super(message);
    this.name = "ApiError";
    this.payload = payload;
    this.status = status;
  }
}

export function detailMessage(error: unknown): string {
  if (!error) return "请求失败";
  if (typeof error === "string") return error;
  const e = error as Record<string, unknown>;
  if (e.detail) {
    if (typeof e.detail === "string") return e.detail;
    const d = e.detail as Record<string, unknown>;
    if (d.message) return String(d.message);
    return JSON.stringify(e.detail);
  }
  if (e.error) return String(e.error);
  if (e.message) return String(e.message);
  return JSON.stringify(error);
}

// Called on 401 so the app can flip back to the login gate. Registered by
// AuthContext at boot; a no-op until then.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | null;
}

export async function api<T = any>(path: string, options?: ApiOptions): Promise<T> {
  let url = path;
  if (typeof url === "string" && url.indexOf("/admin/") === 0) {
    // Normalize legacy absolute /admin/... to the configured base.
    const rest = url.slice("/admin/".length);
    url = adminUrl(...rest.split("/").filter(Boolean));
  }
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    ...(options || {}),
  });
  const type = res.headers.get("content-type") || "";
  const payload = type.indexOf("application/json") >= 0 ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(detailMessage(payload), payload, res.status);
  }
  return payload as T;
}
