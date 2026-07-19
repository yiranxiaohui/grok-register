import { useCallback, useEffect, useRef, useState } from "react";
import { adminUrl } from "@/lib/adminBase";
import { api } from "@/lib/api";
import { toChineseText } from "@/lib/status";
import { renderLog } from "@/lib/logRender";
import {
  DateCell,
  IdentityCell,
  ProbeCell,
  RemoteCell,
  StatusBadge,
} from "@/lib/accountCells";
import type { Account, AccountStats, AccountsResponse } from "@/lib/types";
import { Badge } from "@/components/Badge";
import { Terminal } from "@/components/Terminal";
import { useToast } from "@/context/ToastContext";
import { useOperation } from "@/context/OperationContext";

type SortField = "created_at" | "email" | "status" | "remote" | "probe";
type SortOrder = "asc" | "desc";

interface Filters {
  q: string;
  status: string;
  probe: string;
  remote: string;
}

const emptyFilters: Filters = { q: "", status: "", probe: "", remote: "" };

function emailKey(acc: Account | string): string {
  if (acc && typeof acc === "object") return String(acc.email || "").trim().toLowerCase();
  return String(acc || "").trim().toLowerCase();
}

export function AccountsView() {
  const { toast } = useToast();
  const op = useOperation();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [stats, setStats] = useState<AccountStats>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalPages, setTotalPages] = useState(1);
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [statusBadge, setStatusBadge] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad" }>({ text: "待机", kind: "" });
  const [logData, setLogData] = useState<unknown>("就绪");

  // Probe settings
  const [probeLimit, setProbeLimit] = useState(20);
  const [probeConcurrency, setProbeConcurrency] = useState(2);
  const [probeCooldown, setProbeCooldown] = useState(1000);

  // Freeze order (keep row order stable while selecting / probing).
  const freeze = useRef<{ order: string[] | null; until: number }>({ order: null, until: 0 });
  const filteredRef = useRef<Account[]>([]);
  const selectedRef = useRef<Set<string>>(selected);
  selectedRef.current = selected;

  const shouldFreeze = () => {
    if (selectedRef.current.size > 0) return true;
    if (freeze.current.order && freeze.current.order.length && Date.now() < freeze.current.until) return true;
    return false;
  };
  const captureFreeze = (ttl: number) => {
    const emails = filteredRef.current.map(emailKey).filter(Boolean);
    if (!emails.length) return;
    freeze.current = { order: emails, until: Date.now() + Math.max(3000, ttl) };
  };
  const clearFreeze = () => {
    freeze.current = { order: null, until: 0 };
  };
  const applyFrozenOrder = (list: Account[]): Account[] => {
    if (!shouldFreeze()) {
      if (freeze.current.order && Date.now() >= freeze.current.until) clearFreeze();
      return list;
    }
    const prev = freeze.current.order || filteredRef.current.map(emailKey).filter(Boolean);
    if (!prev.length) return list;
    const map = new Map<string, Account>();
    list.forEach((acc) => {
      const k = emailKey(acc);
      if (k) map.set(k, acc);
    });
    const ordered: Account[] = [];
    prev.forEach((e) => {
      if (map.has(e)) {
        ordered.push(map.get(e)!);
        map.delete(e);
      }
    });
    map.forEach((acc) => ordered.push(acc));
    freeze.current.order = ordered.map(emailKey).filter(Boolean);
    return ordered;
  };

  const attachRemote = (list: Account[]): Account[] =>
    list.map((acc) => ({ ...acc, _remote: acc.remote || null }));

  const filterQuery = useCallback(() => {
    const sort = `${sortField}_${sortOrder}`;
    return (
      "sort=" + encodeURIComponent(sort) +
      "&q=" + encodeURIComponent(filters.q.trim()) +
      "&status=" + encodeURIComponent(filters.status) +
      "&probe=" + encodeURIComponent(filters.probe) +
      "&remote=" + encodeURIComponent(filters.remote)
    );
  }, [sortField, sortOrder, filters]);

  const refresh = useCallback(async () => {
    const data = await api<AccountsResponse>(
      adminUrl("api", "accounts") +
        "?page=" + page +
        "&page_size=" + pageSize +
        "&" + filterQuery(),
    );
    let list = data.accounts || [];
    setTotal(data.total || list.length || 0);
    setPage(data.page || page);
    setPageSize(data.page_size || pageSize);
    setTotalPages(data.total_pages || 1);
    setStats(data.stats || {});
    list = applyFrozenOrder(attachRemote(list));
    filteredRef.current = list;
    setAccounts(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, filterQuery]);

  useEffect(() => {
    refresh().catch((err) => {
      setLogData((err as { payload?: unknown }).payload || (err as Error).message);
      toast((err as Error).message);
    });
  }, [refresh, toast]);

  // React to cross-view refresh requests (e.g. after registration).
  useEffect(() => {
    const handler = () => refresh().catch(() => {});
    window.addEventListener("accounts:refresh", handler);
    return () => window.removeEventListener("accounts:refresh", handler);
  }, [refresh]);

  const changeSort = (field: SortField, initial: SortOrder) => {
    let order: SortOrder;
    if (sortField === field) order = sortOrder === "asc" ? "desc" : "asc";
    else order = initial;
    setSortField(field);
    setSortOrder(order);
    setPage(1);
    clearFreeze();
  };

  const setFilter = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
    clearFreeze();
  };

  const clearFilters = () => {
    setFilters(emptyFilters);
    setPage(1);
  };

  const changePage = (p: number) => {
    setPage(Math.max(1, Math.min(totalPages || 1, p)));
    clearFreeze();
  };

  // ---- selection ----
  const toggleOne = (email: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(email);
        captureFreeze(60000);
      } else {
        next.delete(email);
        if (!next.size) clearFreeze();
      }
      return next;
    });
  };

  const togglePage = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      filteredRef.current.forEach((acc) => {
        const e = emailKey(acc);
        if (!e) return;
        if (checked) next.add(e);
        else next.delete(e);
      });
      if (checked) captureFreeze(60000);
      else if (!next.size) clearFreeze();
      return next;
    });
  };

  const selectAllFiltered = async () => {
    if (total > 0 && selected.size >= total) {
      setSelected(new Set());
      clearFreeze();
      toast("已清空选择");
      return;
    }
    setStatusBadge({ text: "全选中…", kind: "warn" });
    const data = await api<{ emails?: string[]; total?: number; truncated?: boolean }>(
      adminUrl("api", "accounts", "emails") + "?" + filterQuery() + "&limit=50000",
    );
    const emails = (data.emails || []).map((e) => String(e || "").toLowerCase()).filter(Boolean);
    setSelected(new Set(emails));
    setStatusBadge({ text: "已全选筛选结果", kind: "ok" });
    let msg = "已选中筛选结果 " + emails.length + " 个";
    if (data.truncated) msg += "（结果过多，仅取前 " + emails.length + " 个）";
    toast(msg);
    setLogData({ ok: true, selected: emails.length, total: data.total, truncated: !!data.truncated });
  };

  const clearSelected = () => {
    setSelected(new Set());
    clearFreeze();
    toast("已清空选择");
  };

  const selectedEmails = () => Array.from(selected);

  // ---- probe ----
  const probePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const renderProbeProgress = (task: any): boolean => {
    const status = String(task.status || "idle");
    const text = "探测：" + (task.done || 0) + " / " + (task.total || 0) + "，成功 " + (task.success || 0);
    op.update(text + (status === "stopping" ? "\n停止中：不再发起新请求，等待在途请求完成。" : ""));
    if (status === "running" || status === "stopping") {
      setStatusBadge({ text: text + (status === "stopping" ? "，停止中" : ""), kind: "warn" });
      return false;
    }
    if (status === "completed") setStatusBadge({ text: text + "，已完成", kind: "ok" });
    else if (status === "stopped") setStatusBadge({ text: text + "，已停止", kind: "warn" });
    else if (status === "failed") setStatusBadge({ text: "探测失败", kind: "bad" });
    return true;
  };

  const pollProbe = useCallback(async () => {
    const task = await api<any>(adminUrl("api", "accounts", "probe", "status"));
    if (!task.running && task.status === "idle") return;
    const finished = renderProbeProgress(task);
    if (!finished) return;
    if (probePollRef.current) clearInterval(probePollRef.current);
    probePollRef.current = null;
    setLogData(task.result || task);
    captureFreeze(8000);
    await refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const watchProbe = useCallback(() => {
    if (probePollRef.current) clearInterval(probePollRef.current);
    probePollRef.current = setInterval(() => {
      pollProbe().catch((err) => {
        if (probePollRef.current) clearInterval(probePollRef.current);
        probePollRef.current = null;
        toast((err as Error).message);
      });
    }, 1000);
    return pollProbe();
  }, [pollProbe, toast]);

  const startProbe = async (payload: Record<string, unknown>, description: string) => {
    captureFreeze(120000);
    op.show(description + "日志", "正在创建探测任务...");
    const data = await api<any>(adminUrl("api", "accounts", "probe"), {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setLogData(description + "已启动：" + (data.total || 0) + " 个。刷新页面后会继续显示进度。");
    renderProbeProgress(data);
    await watchProbe();
  };

  const probeAll = () =>
    startProbe(
      { model: "grok-4.5", limit: probeLimit, concurrency: probeConcurrency, cooldown_ms: probeCooldown },
      "列表探测",
    );

  const probeSelected = () => {
    const emails = selectedEmails();
    if (!emails.length) {
      toast("先选择账号");
      return Promise.resolve();
    }
    return startProbe(
      { model: "grok-4.5", emails, concurrency: probeConcurrency, cooldown_ms: probeCooldown },
      "选中探测",
    );
  };

  const stopProbe = async () => {
    const data = await api<any>(adminUrl("api", "accounts", "probe", "stop"), { method: "POST" });
    setLogData(data);
    op.update("停止中：不再发起新请求，等待在途请求完成。");
    setStatusBadge({ text: "探测停止中", kind: "warn" });
  };

  // ---- relogin ----
  const reloginPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reloginSelected = async () => {
    const emails = selectedEmails();
    if (!emails.length) {
      toast("先选择账号");
      return;
    }
    op.show("重登日志", "正在创建重登任务...", { stoppable: true, onStop: () => void stopRelogin() });
    setStatusBadge({ text: "重登中", kind: "warn" });
    await api<any>(adminUrl("api", "accounts", "relogin"), {
      method: "POST",
      body: JSON.stringify({ emails, concurrency: probeConcurrency }),
    });

    const pollRelogin = async (): Promise<boolean> => {
      const task = await api<any>(adminUrl("api", "accounts", "relogin", "status"));
      const status = String(task.status || "idle");
      const lines = [
        "重登进度：" + (task.done || 0) + " / " + (task.total || 0) + "（并发 " + (task.concurrency || 1) + "，错峰 " + (task.stagger_ms != null ? task.stagger_ms : 0) + "ms）",
        "成功：" + (task.success || 0) + "，失败：" + (task.failed || 0) + (task.cancelled ? "，已取消：" + task.cancelled : ""),
      ];
      if (status === "stopping" || (task.running && task.stopped)) lines.push("停止中：未开始的已取消；排队过盾会退出；仅收尾在途请求。");
      if (task.running && task.message) lines.push("当前：" + (task.email || "-") + " - " + toChineseText(task.message));
      if (task.sync && !task.running) {
        const sync = task.sync || {};
        lines.push("远端同步：" + (sync.uploaded || 0) + " / " + (sync.total || 0) + (sync.failed_batches ? "，失败批次 " + sync.failed_batches : "") + (sync.batch_size ? "（每批 " + sync.batch_size + "）" : ""));
        if (sync.error) lines.push("同步错误：" + toChineseText(sync.error));
      }
      (task.results || []).slice(-12).forEach((item: any) => {
        const tag = item.ok ? "成功" : item.cancelled ? "取消" : "失败";
        lines.push(tag + "  " + (item.email || "-") + (item.error ? " - " + toChineseText(item.error) : ""));
      });
      op.update(lines.join("\n"));
      const kind = task.status === "failed" ? "bad" : task.running ? "warn" : status === "stopped" ? "warn" : "ok";
      setStatusBadge({
        text: "重登：" + (task.done || 0) + " / " + (task.total || 0) + "，成功 " + (task.success || 0) + "，失败 " + (task.failed || 0) + (task.cancelled ? "，取消 " + task.cancelled : "") + (status === "stopping" ? "，停止中" : status === "stopped" ? "，已停止" : ""),
        kind,
      });
      if (task.running) return false;
      op.setStopVisible(false);
      setLogData(task);
      const syncDone = task.sync ? "，同步 " + (task.sync.uploaded || 0) + "/" + (task.sync.total || 0) : "";
      toast(status === "stopped" ? "重登已停止：成功 " + (task.success || 0) + "，失败 " + (task.failed || 0) : "重登完成：成功 " + (task.success || 0) + "，失败 " + (task.failed || 0) + syncDone);
      await refresh();
      return true;
    };

    if (reloginPollRef.current) clearInterval(reloginPollRef.current);
    const done = await pollRelogin();
    if (done) return;
    reloginPollRef.current = setInterval(() => {
      pollRelogin()
        .then((finished) => {
          if (finished && reloginPollRef.current) {
            clearInterval(reloginPollRef.current);
            reloginPollRef.current = null;
          }
        })
        .catch((err) => {
          if (reloginPollRef.current) clearInterval(reloginPollRef.current);
          reloginPollRef.current = null;
          op.setStopVisible(false);
          toast((err as Error).message);
        });
    }, 1000);
  };

  const stopRelogin = async () => {
    const data = await api<any>(adminUrl("api", "accounts", "relogin", "stop"), { method: "POST" });
    setLogData(data);
    op.update("停止中：取消未开始任务，正在中断排队中的过盾；已在途的请求会尽快退出。");
    setStatusBadge({ text: "重登停止中", kind: "warn" });
    toast(data.message || "已请求停止重登");
  };

  // ---- upload / delete / remote ----
  const uploadSelectedGrok2api = async () => {
    const emails = selectedEmails();
    if (!emails.length) {
      toast("先选择账号");
      return;
    }
    // Mode comes from Settings → Grok2API 导入/导出格式.
    let mode = "build_auth_files";
    try {
      const cfg = await api<{ config?: { upload_mode?: string } }>(adminUrl("api", "grok2api", "config"));
      mode = cfg.config?.upload_mode || "build_auth_files";
    } catch {
      /* fall back to auth files */
    }
    setStatusBadge({ text: "Grok2API 导入中：0 / " + emails.length, kind: "warn" });
    op.show("Grok2API 导入日志", "准备导入 " + emails.length + " 个选中账号...\n模式：" + (mode === "web_sso" ? "网页 SSO" : "auth 文件"));
    const data = await api<any>(adminUrl("api", "grok2api", "upload"), {
      method: "POST",
      body: JSON.stringify({ mode, limit: emails.length, emails }),
    });
    setLogData(data);
    const success = data.uploaded != null ? data.uploaded : data.ok ? data.created || data.files || data.sso || 0 : 0;
    const failed = data.failed || data.syncFailed || 0;
    op.update("Grok2API 导入完成\n成功：" + success + "\n失败：" + failed + (data.error ? "\n错误：" + toChineseText(data.error) : ""));
    setStatusBadge({ text: "Grok2API：成功 " + success + "，失败 " + failed, kind: data.ok ? "ok" : "warn" });
    toast("Grok2API 已处理");
    await refresh();
  };

  const uploadSelectedCpa = async () => {
    const emails = selectedEmails();
    if (!emails.length) {
      toast("先选择账号");
      return;
    }
    setStatusBadge({ text: "CPA 导入中：0 / " + emails.length, kind: "warn" });
    op.show("CPA 导入日志", "准备导入 " + emails.length + " 个选中账号...");
    const data = await api<any>(adminUrl("api", "cpa", "upload"), {
      method: "POST",
      body: JSON.stringify({ limit: emails.length, emails }),
    });
    setLogData(data);
    op.update("CPA 导入完成\n处理：" + (data.files || 0) + "\n成功：" + (data.uploaded || 0) + "\n失败：" + (data.failed || 0) + "\n跳过：" + (data.skipped || 0));
    setStatusBadge({ text: "CPA：成功 " + (data.uploaded || 0) + "，失败 " + (data.failed || 0), kind: data.ok ? "ok" : "warn" });
    toast("CPA 已处理：" + (data.files || 0));
    await refresh();
  };

  const deleteSelected = async () => {
    const emails = selectedEmails();
    if (!emails.length) {
      toast("先选择账号");
      return;
    }
    if (!confirm("删除选中的 " + emails.length + " 个账号？删除前会自动备份。")) return;
    setStatusBadge({ text: "删除中", kind: "warn" });
    const data = await api<any>(adminUrl("api", "accounts"), {
      method: "DELETE",
      body: JSON.stringify({ emails }),
    });
    setLogData(data);
    setStatusBadge({ text: "删除完成", kind: "ok" });
    setSelected(new Set());
    toast("已删除：" + (data.deleted || 0));
    await refresh();
  };

  const deleteCpaAbnormalSelected = async () => {
    const emails = selectedEmails();
    if (!emails.length) {
      toast("先选择账号");
      return;
    }
    if (!confirm("删除选中账号在 CPA 上的异常 auth 并清理本地？\n只处理异常状态（需重登/额度用尽/权限拒绝），健康账号会跳过。删除前自动备份。")) return;
    setStatusBadge({ text: "删除 CPA 异常中", kind: "warn" });
    const data = await api<any>(adminUrl("api", "cpa", "delete-abnormal"), {
      method: "POST",
      body: JSON.stringify({ emails }),
    });
    setLogData(data);
    const deleted = data.deleted || 0;
    const skipped = (data.skipped && data.skipped.length) || 0;
    const failed = (data.failed && data.failed.length) || 0;
    setStatusBadge({ text: `CPA 异常删除：成功 ${deleted}，跳过 ${skipped}，失败 ${failed}`, kind: data.ok ? "ok" : "warn" });
    setSelected(new Set());
    toast("已删除 CPA 异常：" + deleted);
    await refresh();
  };

  const pullRemote = async (mode: "full" | "problems") => {
    const isFull = mode === "full";
    setStatusBadge({ text: isFull ? "拉取远端全部中" : "拉取远端异常中", kind: "warn" });
    setLogData(isFull ? "正在拉取远端全部账号（全量镜像）。" : "正在拉取远端异常账号（仅失败/需重登/限流/禁用）。");
    const data = await api<any>(adminUrl("api", "grok2api", "remote-status"), {
      method: "POST",
      body: JSON.stringify({ providers: "all", page_size: 200, mode }),
    });
    if (data && typeof data === "object") {
      setStats((s) => ({
        ...s,
        remote_total: data.remote_total,
        remote_only_failures: data.remote_only_failures,
        matched_local: data.matched_local,
        local_total: data.local_total,
        remote_synced: true,
      }));
    }
    setLogData(data);
    setStatusBadge({ text: "远端已拉取", kind: "ok" });
    const pulled = Number(data.remote_total || data.problem_total || 0);
    toast((isFull ? "全部已拉取：" : "异常已拉取：") + pulled + " 条");
    await refresh();
  };

  const exportAccounts = async () => {
    // Export format follows Settings → Grok2API 导入/导出格式. Views are
    // separated now, so fetch the current mode instead of reading a shared form.
    let mode = "build_auth_files";
    try {
      const cfg = await api<{ config?: { upload_mode?: string } }>(adminUrl("api", "grok2api", "config"));
      mode = cfg.config?.upload_mode || "build_auth_files";
    } catch {
      /* fall back to auth files */
    }
    if (mode === "web_sso") {
      window.location.href =
        adminUrl("api", "accounts", "register-email", "export-sso") +
        "?status=imported,registered,active&format=sso&download=1";
      return;
    }
    window.location.href = adminUrl("api", "accounts", "register-email", "export-auth-zip") + "?limit=5000";
  };
  const exportCpa = () => {
    window.location.href = adminUrl("api", "accounts", "register-email", "export-cpa-zip") + "?limit=5000";
  };

  // Clean up polling timers on unmount.
  useEffect(() => {
    return () => {
      if (probePollRef.current) clearInterval(probePollRef.current);
      if (reloginPollRef.current) clearInterval(reloginPollRef.current);
    };
  }, []);

  const run = (fn: () => Promise<void> | void) => {
    Promise.resolve(fn()).catch((err) => {
      setStatusBadge({ text: "失败", kind: "bad" });
      setLogData((err as { payload?: unknown }).payload || (err as Error).message);
      toast((err as Error).message);
    });
  };

  // Derived selection UI
  const pageEmails = accounts.map(emailKey).filter(Boolean);
  const pageChecked = pageEmails.length > 0 && pageEmails.every((e) => selected.has(e));
  const pageIndeterminate = !pageChecked && pageEmails.some((e) => selected.has(e));
  const selectedCountLabel =
    total > 0 && selected.size >= total && selected.size > 0
      ? "已选：全部 " + selected.size
      : total > 0 && selected.size > 0
        ? "已选：" + selected.size + " / " + total
        : "已选：" + selected.size;
  const selectAllLabel = total > 0 && selected.size >= total && selected.size > 0 ? "取消全选" : "全选筛选";

  const remoteSynced = !!stats.remote_synced || !!stats.remote_total;
  const localTotal = Number(stats.local_total != null ? stats.local_total : total);

  return (
    <div id="view-accounts" className="view active">
      <section className="section accounts-panel" aria-labelledby="accounts-title">
        <div className="table-tools">
          <div>
            <h2 id="accounts-title" className="section-title">账号池</h2>
          </div>
        </div>
        <div className="accounts-stats" aria-label="账号统计">
          <div className="stat-card">
            <p className="stat-label">本地账号</p>
            <p className="stat-value">{localTotal}</p>
            <div className="stat-sub">本地记录</div>
          </div>
          <div className="stat-card">
            <p className="stat-label">当前筛选</p>
            <p className="stat-value">{total}</p>
            <div className="stat-sub">筛选匹配</div>
          </div>
          <div className="stat-card">
            <p className="stat-label">需重登</p>
            <p className="stat-value">{remoteSynced ? Number(stats.remote_relogin || 0) : "--"}</p>
            <div className="stat-sub">库内远端缓存</div>
          </div>
          <div className="stat-card">
            <p className="stat-label">远端异常</p>
            <p className="stat-value">{remoteSynced ? Number(stats.remote_failed || 0) : "--"}</p>
            <div className="stat-sub">{remoteSynced ? "库内远端缓存" : "尚未拉取远端"}</div>
          </div>
        </div>

        <div className="accounts-toolbar">
          <div className="accounts-filters">
            <div className="search-field">
              <label htmlFor="account-filter-q">搜索</label>
              <input
                id="account-filter-q"
                placeholder="邮箱、ID、批次"
                autoComplete="off"
                value={filters.q}
                onChange={(e) => setFilter({ q: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="account-filter-status">本地状态</label>
              <select id="account-filter-status" value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
                <option value="">全部</option>
                <option value="active">可用</option>
                <option value="relogged">已重登</option>
                <option value="registered">已注册</option>
                <option value="credentials_only">仅密码</option>
                <option value="probe_failed">测活失败</option>
                <option value="failed">失败</option>
                <option value="disabled">已停用</option>
              </select>
            </div>
            <div>
              <label htmlFor="account-filter-probe">测活</label>
              <select id="account-filter-probe" value={filters.probe} onChange={(e) => setFilter({ probe: e.target.value })}>
                <option value="">全部</option>
                <option value="ok">通过</option>
                <option value="failed">失败</option>
                <option value="untested">未测</option>
              </select>
            </div>
            <div>
              <label htmlFor="account-filter-remote">远端状态</label>
              <select id="account-filter-remote" value={filters.remote} onChange={(e) => setFilter({ remote: e.target.value })}>
                <option value="">全部</option>
                <option value="not_imported">未导入</option>
                <option value="not_synced">未同步</option>
                <option value="relogin">需重登</option>
                <option value="wait">限流等待</option>
                <option value="failed">异常</option>
                <option value="ok">正常</option>
              </select>
            </div>
            <div>
              <label htmlFor="account-sort-field">排序字段</label>
              <select id="account-sort-field" value={sortField} onChange={(e) => { setSortField(e.target.value as SortField); setPage(1); clearFreeze(); }}>
                <option value="created_at">创建时间</option>
                <option value="email">邮箱</option>
                <option value="status">本地状态</option>
                <option value="remote">远端状态</option>
              </select>
            </div>
            <div>
              <label htmlFor="account-sort-order">排序顺序</label>
              <select id="account-sort-order" value={sortOrder} onChange={(e) => { setSortOrder(e.target.value as SortOrder); setPage(1); clearFreeze(); }}>
                <option value="asc">升序</option>
                <option value="desc">降序</option>
              </select>
            </div>
            <button className="btn ghost" type="button" onClick={clearFilters}>清除筛选</button>
          </div>
          <div className="accounts-probe-settings">
            <div>
              <label htmlFor="probe-limit">探测数量</label>
              <input id="probe-limit" type="number" min={1} max={200} value={probeLimit} onChange={(e) => setProbeLimit(Number(e.target.value))} />
            </div>
            <div>
              <label htmlFor="probe-concurrency">探测并发</label>
              <input id="probe-concurrency" type="number" min={1} max={10} value={probeConcurrency} onChange={(e) => setProbeConcurrency(Number(e.target.value))} />
            </div>
            <div>
              <label htmlFor="probe-cooldown-ms">冷静期（毫秒）</label>
              <input id="probe-cooldown-ms" type="number" min={0} max={60000} value={probeCooldown} onChange={(e) => setProbeCooldown(Number(e.target.value))} />
            </div>
          </div>
        </div>

        <div className="accounts-bottom-actions">
          <div className="actions">
            <button className="btn" type="button" onClick={() => run(refresh)}>刷新</button>
            <button className="btn" type="button" title="按锁定的远端拉取全部" onClick={() => run(() => pullRemote("full"))}>拉取远端全部</button>
            <button className="btn" type="button" title="只拉异常" onClick={() => run(() => pullRemote("problems"))}>拉取远端异常</button>
            <button className="btn" type="button" onClick={() => run(probeAll)}>探测列表</button>
            <button className="btn ghost" type="button" onClick={() => run(stopProbe)}>停止探测</button>
            <button className="btn" type="button" onClick={() => run(exportAccounts)}>导出</button>
            <button className="btn" type="button" onClick={exportCpa}>导出 CPA</button>
          </div>
          <div className="pager-actions">
            <Badge>{selectedCountLabel}</Badge>
            <button className="btn" type="button" title="选中当前筛选条件下的全部账号" onClick={() => run(selectAllFiltered)}>{selectAllLabel}</button>
            <button className="btn ghost" type="button" onClick={clearSelected}>清空选择</button>
            <button className="btn" type="button" onClick={() => run(probeSelected)}>探测选中</button>
            <button className="btn" type="button" onClick={() => run(uploadSelectedGrok2api)}>Grok2API 导入</button>
            <button className="btn" type="button" onClick={() => run(uploadSelectedCpa)}>CPA 导入</button>
            <button className="btn primary" type="button" onClick={() => run(reloginSelected)}>重登</button>
            <button className="btn danger" type="button" onClick={() => run(deleteSelected)}>删除选中</button>
            <button className="btn danger" type="button" onClick={() => run(deleteCpaAbnormalSelected)}>删除 CPA 异常</button>
          </div>
        </div>

        <div className="summary-row">
          <Badge kind={statusBadge.kind}>{statusBadge.text}</Badge>
          <Badge>本地：{localTotal}</Badge>
          <Badge>筛选：{total}</Badge>
          <Badge>当前页：{accounts.length}</Badge>
          <Badge>已选：{selected.size}</Badge>
        </div>
        <Terminal className="compact" content={renderLog("accounts-log", logData)} />

        <div className="account-tab-panel active">
          <div className="table-wrap">
            <table className="account-table">
              <colgroup>
                <col className="col-check" />
                <col className="col-email" />
                <col className="col-status" />
                <col className="col-probe" />
                <col className="col-remote" />
                <col className="col-created" />
              </colgroup>
              <thead>
                <tr>
                  <th className="check-cell">
                    <input
                      type="checkbox"
                      aria-label="选择当前页"
                      checked={pageChecked}
                      ref={(el) => { if (el) el.indeterminate = pageIndeterminate; }}
                      onChange={(e) => togglePage(e.target.checked)}
                    />
                  </th>
                  <SortHeader label="邮箱" field="email" active={sortField} order={sortOrder} onSort={() => changeSort("email", "asc")} />
                  <SortHeader label="状态" field="status" active={sortField} order={sortOrder} onSort={() => changeSort("status", "asc")} />
                  <SortHeader label="测活" field="probe" active={sortField} order={sortOrder} onSort={() => changeSort("probe", "asc")} />
                  <SortHeader label="远端状态" field="remote" active={sortField} order={sortOrder} onSort={() => changeSort("remote", "asc")} />
                  <SortHeader label="创建时间" field="created_at" active={sortField} order={sortOrder} onSort={() => changeSort("created_at", "desc")} />
                </tr>
              </thead>
              <tbody>
                {accounts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty">暂无账号</td>
                  </tr>
                ) : (
                  accounts.map((acc) => {
                    const email = emailKey(acc);
                    const isSel = email && selected.has(email);
                    return (
                      <tr key={email || acc.id} className={isSel ? "is-selected" : undefined} data-email={email}>
                        <td>
                          <input
                            className="account-check"
                            type="checkbox"
                            checked={!!isSel}
                            onChange={(e) => toggleOne(email, e.target.checked)}
                          />
                        </td>
                        <td><IdentityCell acc={acc} /></td>
                        <td className="status-cell"><StatusBadge status={accStatusFor(acc)} /></td>
                        <td className="probe-cell-wrap"><ProbeCell probe={acc.last_probe} /></td>
                        <td className="probe-cell-wrap"><RemoteCell acc={acc} /></td>
                        <td className="date-cell"><DateCell value={acc.created_at} /></td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <div className="pager-actions">
              <Badge>第 {page} / {totalPages} 页</Badge>
              <button className="btn ghost" type="button" onClick={() => run(() => changePage(1))}>首页</button>
              <button className="btn ghost" type="button" onClick={() => run(() => changePage(page - 1))}>上一页</button>
              <button className="btn ghost" type="button" onClick={() => run(() => changePage(page + 1))}>下一页</button>
              <button className="btn ghost" type="button" onClick={() => run(() => changePage(totalPages || 1))}>末页</button>
            </div>
            <div className="pager-actions">
              <span className="page-size-control">
                <label htmlFor="accounts-page-size">每页</label>
                <select id="accounts-page-size" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span className="muted">条</span>
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// accountStatus display alias, matching accountCells but the local-status column
// uses the DB status directly for filtering; badge normalizes ok/imported.
function accStatusFor(acc: Account): string {
  const s = String(acc.status || "").toLowerCase();
  if (!s) return "registered";
  if (s === "ok" || s === "imported") return "active";
  return s;
}

function SortHeader({
  label,
  field,
  active,
  order,
  onSort,
}: {
  label: string;
  field: SortField;
  active: SortField;
  order: SortOrder;
  onSort: () => void;
}) {
  const isActive = active === field;
  const indicator = isActive ? (order === "asc" ? "↑" : "↓") : "↕";
  return (
    <th>
      <button
        className={"sort-head" + (isActive ? " active" : "")}
        type="button"
        aria-sort={isActive ? (order === "asc" ? "ascending" : "descending") : "none"}
        onClick={onSort}
      >
        {label} <span className="sort-indicator" aria-hidden="true">{indicator}</span>
      </button>
    </th>
  );
}
