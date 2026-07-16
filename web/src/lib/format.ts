// Formatting helpers ported from accounts.html. React handles HTML escaping,
// so escapeHtml is intentionally omitted.

export interface DateParts {
  date: string;
  time: string;
}

export function formatDateParts(value: unknown): DateParts | null {
  if (!value) return null;
  let date: Date;
  if (typeof value === "number" || /^[0-9]+(\.[0-9]+)?$/.test(String(value))) {
    date = new Date(Number(value) * 1000);
  } else {
    date = new Date(String(value).replace(/\.\d{6,}Z$/, "Z"));
  }
  if (!Number.isFinite(date.getTime())) return { date: String(value), time: "" };
  return {
    date: date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
    time: date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

export function formatTs(ts: unknown): string {
  const n = Number(ts || 0);
  if (!n) return "--";
  try {
    return new Date(n * 1000).toLocaleString();
  } catch {
    return String(n);
  }
}

export function maskProxyText(text: unknown): string {
  return String(text || "").replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, "://$1:***@");
}

export function proxyLines(text: unknown): string[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parts = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/[\n;]+/);
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  parts.forEach((part) => {
    String(part || "").split(",").forEach((piece) => {
      const line = piece.trim();
      if (!line || line.charAt(0) === "#" || seen[line]) return;
      seen[line] = true;
      out.push(line);
    });
  });
  return out;
}

export function shortId(value: unknown): string {
  const s = String(value || "").trim();
  if (!s || s === "-") return "";
  return s.length > 18 ? s.slice(0, 10) + "..." + s.slice(-5) : s;
}
