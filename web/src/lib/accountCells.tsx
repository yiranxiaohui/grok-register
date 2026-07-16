import type { JSX } from "react";
import type { Account, ProbeInfo, RemoteInfo } from "./types";
import { translateStatus, toChineseText } from "./status";
import { formatDateParts } from "./format";

// Account-table cell rendering ported from accounts.html. Original built HTML
// strings; here they return JSX. Logic (status classification) is 1:1.

export function accountStatus(acc: Account): string {
  const status = String(acc.status || "").toLowerCase();
  if (!status) return "registered";
  if (status === "ok" || status === "imported") return "active";
  return status;
}

export function probeState(probe: ProbeInfo | undefined): "ok" | "failed" | "untested" {
  probe = probe || {};
  if (probe.ok === true || probe.ok === 1) return "ok";
  if (probe.error || Number(probe.status_code || 0) >= 400 || probe.ok === false || probe.ok === 0) return "failed";
  return "untested";
}

export function remoteAction(acc: Account): string {
  const remote = (acc && (acc._remote || acc.remote)) || null;
  if (!remote) return "not_synced";
  const localStatus = String((acc && acc.status) || "").toLowerCase();
  const remoteReason = String(remote.reason || "").toLowerCase();
  if (localStatus === "relogged") return "ok";
  if (remoteReason.indexOf("assumed_ok_problems_cache") >= 0) return "normal";
  const action = String(remote.action || remote.inspection_action || remote.remote_action || "").toLowerCase();
  const classification = String(remote.classification || "").toLowerCase();
  if (action === "not_imported" || classification === "not_imported") return "not_imported";
  if (action === "not_synced" || classification === "not_synced") return "not_synced";
  if (action === "wait" || classification === "wait" || classification === "waitingreset") return "wait";
  const status = Number(remote.http_status || remote.status_code || remote.code || 0);
  if (action.indexOf("relogin") >= 0 || classification === "reauth" || classification === "relogin") return "relogin";
  if (action.indexOf("missing") >= 0) return "missing";
  if (action.indexOf("fail") >= 0 || action.indexOf("error") >= 0 || classification === "probe_error" || classification === "disabled") return "failed";
  if (status === 401 || status === 403) return "relogin";
  if (status >= 400) return "failed";
  if (remoteReason.indexOf("local_upload") >= 0 || remoteReason.indexOf("manual_upload") >= 0) return "ok";
  if (action === "keep" || classification === "healthy" || status === 200) return "ok";
  if (remote.ok === true || action === "ok" || action === "active") return "ok";
  return "failed";
}

function badgeKind(status: string): "ok" | "warn" | "bad" {
  const s = String(status || "-").toLowerCase();
  if (["active", "registered", "ok", "imported", "done", "relogged", "normal"].indexOf(s) >= 0) return "ok";
  if (["untested", "running", "partial", "missing", "queued", "candidate", "credentials_only", "sso_pending", "not_imported", "not_synced", "wait"].indexOf(s) >= 0) return "warn";
  return "bad";
}

function badgeLabel(status: string): string {
  const s = String(status || "-").toLowerCase();
  let label = translateStatus(s);
  if (s === "ok") label = "已导入";
  if (s === "normal") label = "正常";
  if (s === "failed") label = "失败";
  if (s === "probe_failed") label = "测活失败";
  if (s === "credentials_only") label = "仅密码";
  if (s === "sso_pending") label = "待授权";
  if (s === "relogged") label = "已重登";
  if (s === "not_imported") label = "未导入";
  if (s === "not_synced") label = "未同步";
  return label;
}

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const kind = badgeKind(status);
  const label = badgeLabel(status);
  return (
    <span className={"badge " + kind} title={label}>
      {label}
    </span>
  );
}

export function ProbeCell({ probe }: { probe: ProbeInfo | undefined }): JSX.Element {
  const p = probe || {};
  const state = probeState(p);
  const label = state === "ok" ? "通过" : state === "failed" ? "失败" : "未测";
  const kind = state === "ok" ? "ok" : state === "failed" ? "bad" : "warn";
  return (
    <span className="probe-cell">
      <span className={"badge " + kind}>{label}</span>
      {p.latency_ms ? <span className="mono muted">{p.latency_ms} ms</span> : null}
      {state === "failed" && p.error ? (
        <span className="truncate mono muted" title={toChineseText(p.error)}>
          {toChineseText(p.error)}
        </span>
      ) : null}
    </span>
  );
}

export function RemoteCell({ acc }: { acc: Account }): JSX.Element {
  const remote: RemoteInfo | null = acc._remote || acc.remote || null;
  if (!remote) return <StatusBadge status="not_synced" />;
  const action = remoteAction(acc);
  let reason = remote.reason || remote.message || remote.error || "";
  if (String(reason).toLowerCase() === "active") reason = "";
  const reasonKey = String(reason || "").replace(/[\s_-]/g, "").toLowerCase();
  if (
    ["reauthrequired", "relogin", "unauthorized", "forbidden", "localuploadok", "manualuploadauthfiles", "manualuploadcpa", "manualuploadsso", "assumedokproblemscache", "localreloginresolved"].indexOf(reasonKey) >= 0
  ) {
    reason = "";
  } else if (reason) {
    reason = toChineseText(reason);
  }
  const httpCode = Number(remote.http_status || remote.status_code || 0);
  const showHttp = httpCode && httpCode !== 200 && action !== "ok" && action !== "not_imported" && action !== "not_synced";
  return (
    <span className="probe-cell">
      <StatusBadge status={action} />
      {showHttp ? <span className="mono muted">HTTP {httpCode}</span> : null}
      {reason ? (
        <span className="truncate mono muted" title={reason}>
          {reason}
        </span>
      ) : null}
    </span>
  );
}

export function IdentityCell({ acc }: { acc: Account }): JSX.Element {
  return (
    <span className="account-main">
      <span className="account-email" title={acc.email || "-"}>
        {acc.email || "-"}
      </span>
    </span>
  );
}

export function DateCell({ value }: { value: unknown }): JSX.Element {
  const parts = formatDateParts(value);
  if (!parts) return <span className="muted">-</span>;
  return (
    <span className="date-cell">
      <span>{parts.date}</span>
      <span className="mono muted">{parts.time}</span>
    </span>
  );
}
