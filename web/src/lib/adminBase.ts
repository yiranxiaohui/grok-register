// Mirrors the original window.__adminUrl helper. The backend injects
// window.__ADMIN_BASE__ so every API path follows the configured admin base
// (e.g. /admin or a hidden /panel).
declare global {
  interface Window {
    __ADMIN_BASE__?: string;
    __adminUrl?: (...parts: (string | number | null | undefined)[]) => string;
  }
}

export function adminBase(): string {
  const raw = String(window.__ADMIN_BASE__ || "/admin").replace(/\/+$/, "");
  return raw || "/admin";
}

export function adminUrl(...parts: (string | number | null | undefined)[]): string {
  const base = adminBase();
  const clean = parts
    .filter((p) => p !== undefined && p !== null && String(p).length > 0)
    .map((p) => String(p).replace(/^\/+|\/+$/g, ""));
  return clean.length ? `${base}/${clean.join("/")}` : base;
}
