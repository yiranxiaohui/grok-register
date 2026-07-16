import type { JSX } from "react";
import { normalizeStatus, readableCheckName, readableProxyStrategy, toChineseText } from "./status";
import { maskProxyText } from "./format";

// Ports renderReadableLog and its helpers. Original built HTML strings; here we
// build JSX. A LogTerminal component renders <pre class="terminal"> with these.

type Kind = "ok" | "warn" | "bad" | "muted" | "";

interface Line {
  text: string;
  kind?: Kind;
  strong?: boolean;
  // Optional inline action button (start-solver) rendered after the line.
  action?: "start-solver";
}

function line(text: string, kind?: Kind, strong?: boolean): Line {
  return { text: text || "-", kind, strong };
}

function extractRegCounts(data: any): { ok: number; fail: number } {
  data = data || {};
  let ok = data.ok_count;
  if (ok == null) ok = data.success;
  if (ok == null) ok = data.imported;
  if (ok == null && data.probe && data.probe.ok != null) ok = data.probe.ok;
  let fail = data.fail_count;
  if (fail == null) fail = data.failed;
  if (fail == null && typeof data.error === "number") fail = data.error;
  if (fail == null && data.probe && data.probe.fail != null) fail = data.probe.fail;
  if ((ok == null || fail == null) && data.status) {
    const st = String(data.status || "").toLowerCase();
    if (st === "imported" || st === "success" || st === "completed" || st === "done") {
      if (ok == null) ok = 1;
      if (fail == null) fail = 0;
    } else if (st === "failed" || st === "error" || st === "probe_failed") {
      if (ok == null) ok = 0;
      if (fail == null) fail = 1;
    }
  }
  return { ok: ok == null ? 0 : ok, fail: fail == null ? 0 : fail };
}

function preflightLines(data: any): Line[] {
  const checks = data.checks || [];
  const lines: Line[] = [line(data.ok ? "自检通过" : "自检未通过", data.ok ? "ok" : "bad", true)];
  checks.forEach((check: any) => {
    const ok = !!check.ok;
    const warning = !ok && check.blocking === false;
    lines.push(
      line(
        (ok ? "通过：" : warning ? "提示：" : "异常：") +
          readableCheckName(check.name) +
          " - " +
          toChineseText(check.message || ""),
        ok ? "ok" : warning ? "warn" : "bad",
      ),
    );
    if (!ok && String(check.name || "").indexOf("本地过盾") >= 0) {
      lines.push({ text: "重新启动本地过盾", action: "start-solver" });
    }
  });
  if (!data.ok) lines.push(line("处理建议：先处理异常项，再重新点击“自检”或“开始”。", "warn"));
  return lines;
}

function taskLines(data: any): Line[] {
  const state = normalizeStatus(data.status || data.batch_status || "running");
  const counts = extractRegCounts(data);
  const lines: Line[] = [
    line("任务状态：" + state.label, state.kind, true),
    line("任务编号：" + (data.id || data.batch_id || "-"), "muted"),
  ];
  if (data.email) lines.push(line("邮箱：" + data.email));
  let message = toChineseText(data.message || "");
  if (!message && typeof data.error === "string") message = toChineseText(data.error);
  if (message) lines.push(line("说明：" + message, state.kind === "bad" ? "bad" : ""));
  if (data.total || data.done || data.running || counts.ok || counts.fail) {
    lines.push(
      line(
        "进度：总数 " +
          (data.total || data.count || 0) +
          "，完成 " +
          (data.done || data.finished || 0) +
          "，成功 " +
          (counts.ok || 0) +
          "，失败 " +
          (counts.fail || 0) +
          (data.running ? "，运行中 " + data.running : ""),
      ),
    );
  }
  if (data.proxy_pool_count != null) lines.push(line("代理池：" + data.proxy_pool_count + " 个"));
  const probe = data.probe || {};
  if (probe.count) {
    lines.push(line("测活：成功 " + (probe.ok || 0) + "，失败 " + (probe.fail || 0), probe.fail ? "warn" : "ok"));
  }
  (data.sessions || []).slice(0, 8).forEach((s: any) => {
    lines.push(
      line(
        "子任务：" +
          (s.email || s.id || "-") +
          " - " +
          normalizeStatus(s.status).label +
          " - " +
          toChineseText(s.message || s.error || ""),
      ),
    );
  });
  if (state.terminal && state.kind === "ok") lines.push(line("账号已保存，正在刷新账号列表。", "ok"));
  return lines;
}

function grok2apiLines(data: any): Line[] {
  const lines: Line[] = [];
  if (data.ok === true) lines.push(line("操作成功", "ok", true));
  else if (data.ok === false) lines.push(line("操作失败", "bad", true));
  if (data.base_url) lines.push(line("地址：" + data.base_url));
  if (data.username) lines.push(line("管理员：" + data.username));
  if (data.count != null) lines.push(line("处理数量：" + data.count));
  if (data.created != null || data.updated != null || data.imported != null) {
    lines.push(
      line(
        "导入结果：新增 " + (data.created || 0) + "，更新 " + (data.updated || 0) + "，总计 " + (data.imported || data.count || 0),
        "ok",
      ),
    );
  }
  if (data.token_hint) lines.push(line("登录令牌：已获取", "ok"));
  if (data.error || data.message) lines.push(line("说明：" + toChineseText(data.error || data.message), data.ok === false ? "bad" : ""));
  return lines.length ? lines : [line("操作完成", "ok")];
}

function cpaLines(data: any): Line[] {
  const lines: Line[] = [];
  if (data.ok === true) lines.push(line("操作成功", "ok", true));
  else if (data.ok === false) lines.push(line("操作失败", "bad", true));
  if (data.base_url) lines.push(line("地址：" + data.base_url));
  if (data.status != null) lines.push(line("状态码：" + data.status));
  if (data.files != null) lines.push(line("文件数：" + data.files));
  if (data.uploaded != null || data.failed != null) {
    lines.push(line("上传结果：成功 " + (data.uploaded || 0) + "，失败 " + (data.failed || 0), data.failed ? "warn" : "ok"));
  }
  if (data.error || data.message) lines.push(line("说明：" + toChineseText(data.error || data.message), data.ok === false ? "bad" : ""));
  (data.results || []).slice(0, 8).forEach((item: any) => {
    lines.push(line((item.name || "-") + "：" + (item.ok ? "成功" : "失败") + " HTTP " + (item.status || "-"), item.ok ? "ok" : "bad"));
  });
  return lines.length ? lines : [line("操作完成")];
}

function probeLines(data: any): Line[] {
  const ok = Number(data.ok || 0);
  const count = Number(data.count || 0);
  const fail = Number(data.fail || Math.max(0, count - ok));
  const lines: Line[] = [line("测活完成：成功 " + ok + "，失败 " + fail, fail ? "warn" : "ok", true)];
  if (data.concurrency != null || data.cooldown_ms != null) {
    lines.push(line("参数：并发 " + (data.concurrency || 1) + "，冷静期 " + (data.cooldown_ms || 0) + " 毫秒"));
  }
  (data.results || []).slice(0, 12).forEach((item: any) => {
    lines.push(
      line(
        (item.email || item.account_id || "-") + "：" + (item.ok ? "可用" : "不可用") + (item.error ? " - " + toChineseText(item.error) : ""),
        item.ok ? "ok" : "bad",
      ),
    );
  });
  return lines;
}

function extractRemoteItems(data: any): any[] {
  if (!data || typeof data !== "object") return [];
  let list = data.accounts || data.items || data.failures || data.failed_items || data.results || data.data;
  if (list && !Array.isArray(list) && Array.isArray(list.items)) list = list.items;
  return Array.isArray(list) ? list : [];
}

function accountsActionLines(data: any): Line[] {
  if (data && data.results && Array.isArray(data.results)) return probeLines(data);
  const lines: Line[] = [];
  if (!data || typeof data !== "object") return [line(toChineseText(data || "操作完成"))];
  if (data.ok === true) lines.push(line("操作成功", "ok", true));
  if (data.ok === false) lines.push(line("操作失败", "bad", true));
  if (data.message) lines.push(line("说明：" + toChineseText(data.message)));
  if (data.error) lines.push(line("错误：" + toChineseText(data.error), "bad"));
  if (data.deleted != null) lines.push(line("已删除：" + data.deleted + " 个", "ok"));
  if (data.backup_path) lines.push(line("备份：" + data.backup_path, "ok"));
  if (data.remote_total != null) lines.push(line("远端总数：" + data.remote_total));
  if (data.matched_local != null) lines.push(line("本地匹配：" + data.matched_local));
  if (data.remote_only_failures != null) {
    lines.push(line("远端异常但本地缺账号密码：" + data.remote_only_failures, data.remote_only_failures ? "warn" : "ok"));
  }
  if (data.provider_counts) {
    lines.push(
      line("来源：" + Object.keys(data.provider_counts).map((k) => k + "=" + data.provider_counts[k]).join("，")),
    );
  }
  const list = extractRemoteItems(data);
  if (list.length) lines.push(line("远端返回：" + list.length + " 条记录", "ok"));
  if (data.total != null) lines.push(line("总数：" + data.total));
  if (data.failed != null || data.fail != null) lines.push(line("失败：" + (data.failed || data.fail || 0), "warn"));
  if (data.created != null || data.count != null) lines.push(line("生成队列：" + (data.created || data.count || 0) + " 条", "ok"));
  return lines.length ? lines : [line("操作完成")];
}

function keyValueLines(data: any): Line[] {
  const lines: Line[] = [];
  if (data.ok === true) lines.push(line("操作成功", "ok", true));
  if (data.message) lines.push(line("说明：" + toChineseText(data.message)));
  if (data.error) lines.push(line("错误：" + toChineseText(data.error), "bad"));
  if (data.config) lines.push(line("配置已保存。", "ok"));
  if (data.deleted != null) lines.push(line("已删除：" + data.deleted + " 个", "ok"));
  if (data.backup_path) lines.push(line("备份：" + data.backup_path, "ok"));
  if (data.proxy_pool) {
    lines.push(
      line(
        "代理池：" + (data.proxy_pool.count || 0) + " 个，策略：" + readableProxyStrategy(data.proxy_pool.strategy),
        data.proxy_pool.count ? "ok" : "muted",
      ),
    );
  }
  if (data.proxy_tested) lines.push(line("本次测试代理：" + maskProxyText(data.proxy_tested)));
  if (data.tested != null) {
    lines.push(
      line(
        "代理测试：共 " + data.tested + " 个，可用 " + (data.available || 0) + " 个，不可达 " + (data.unavailable || 0) + " 个",
        data.unavailable ? "warn" : "ok",
      ),
    );
  }
  if (Array.isArray(data.proxy_results)) {
    data.proxy_results.forEach((item: any, index: number) => {
      const detail = item.ok
        ? "可达，HTTP " + (item.status_code || "-") + "，" + (item.elapsed_ms || 0) + " ms"
        : "不可达" + (item.status_code ? "，HTTP " + item.status_code : "") + (item.error ? "，" + toChineseText(item.error) : "");
      lines.push(line(index + 1 + ". " + maskProxyText(item.proxy) + "：" + detail, item.ok ? "ok" : "bad"));
    });
  }
  if (data.url) lines.push(line("服务地址：" + data.url));
  if (data.pid) lines.push(line("进程号：" + data.pid));
  return lines.length ? lines : [line("操作完成")];
}

export type LogId = "reg-log" | "grok2api-log" | "cpa-log" | "accounts-log" | "schedule-log" | string;

function readableLogLines(id: LogId, data: any): Line[] {
  if (typeof data === "string") return [line(toChineseText(data))];
  if (!data || typeof data !== "object") return [line(String(data || "-"))];
  if (data.detail && data.detail.preflight) return preflightLines(data.detail.preflight);
  if (id === "reg-log" && Array.isArray(data.checks)) return preflightLines(data);
  if (id === "reg-log" && (data.status || data.batch_status || data.id || data.batch_id)) return taskLines(data);
  if (id === "grok2api-log") return grok2apiLines(data);
  if (id === "cpa-log") return cpaLines(data);
  if (id === "accounts-log") return accountsActionLines(data);
  if (data.results && Array.isArray(data.results)) return probeLines(data);
  return keyValueLines(data);
}

export function renderLog(id: LogId, data: any, onAction?: (action: "start-solver") => void): JSX.Element {
  const lines = readableLogLines(id, data);
  return (
    <div className="log-lines">
      {lines.map((l, i) => {
        if (l.action) {
          return (
            <button key={i} type="button" className="inline-action" onClick={() => onAction?.(l.action!)}>
              {l.text}
            </button>
          );
        }
        const cls = "log-line" + (l.kind ? " log-" + l.kind : "") + (l.strong ? " log-title" : "");
        return (
          <div key={i} className={cls}>
            {l.text}
          </div>
        );
      })}
    </div>
  );
}

export function summarizeTask(data: any): any {
  if (!data || typeof data !== "object") return data;
  const counts = extractRegCounts(data);
  return {
    id: data.id || data.batch_id,
    status: data.status || data.batch_status,
    message: data.message || "",
    total: data.total || data.count,
    done: data.done || data.finished,
    success: counts.ok,
    failed: counts.fail,
    imported: data.imported || data.ok_count || counts.ok,
    error: typeof data.error === "string" ? data.error : "",
    cancelled: data.cancelled,
    running: data.running,
    sessions: (data.sessions || []).slice(0, 20).map((s: any) => ({
      id: s.id,
      email: s.email,
      status: s.status,
      message: s.message || s.error || "",
    })),
  };
}

export { extractRegCounts };
