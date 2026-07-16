import { useEffect, useRef } from "react";
import { adminUrl } from "@/lib/adminBase";
import { api } from "@/lib/api";
import { isTaskRunningStatus, toChineseText } from "@/lib/status";
import { useOperation } from "@/context/OperationContext";

// Reconnects the floating operation dialog to a probe/relogin task that is still
// running server-side after a page reload. Registration self-restores inside
// RegisterView; this covers the two dialog-driven tasks. Runs once on mount.
export function useTaskRestore() {
  const op = useOperation();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let probeTimer: ReturnType<typeof setInterval> | null = null;
    let reloginTimer: ReturnType<typeof setInterval> | null = null;

    const renderProbe = (task: any): boolean => {
      const status = String(task.status || "idle");
      const text = "探测：" + (task.done || 0) + " / " + (task.total || 0) + "，成功 " + (task.success || 0);
      op.update(text + (status === "stopping" ? "\n停止中：不再发起新请求，等待在途请求完成。" : ""));
      return status !== "running" && status !== "stopping";
    };

    const restoreProbe = async (): Promise<boolean> => {
      const task = await api<any>(adminUrl("api", "accounts", "probe", "status"));
      if (!isTaskRunningStatus(task.status, task.running)) return false;
      op.show("探测日志", "页面刷新后已恢复探测进度...");
      renderProbe(task);
      probeTimer = setInterval(() => {
        api<any>(adminUrl("api", "accounts", "probe", "status"))
          .then((t) => {
            if (renderProbe(t)) {
              if (probeTimer) clearInterval(probeTimer);
              probeTimer = null;
              window.dispatchEvent(new CustomEvent("accounts:refresh"));
            }
          })
          .catch(() => {
            if (probeTimer) clearInterval(probeTimer);
            probeTimer = null;
          });
      }, 1000);
      return true;
    };

    const restoreRelogin = async () => {
      const task = await api<any>(adminUrl("api", "accounts", "relogin", "status"));
      if (!isTaskRunningStatus(task.status, task.running)) return;
      op.show("重登日志", "正在恢复后端重登进度...", { stoppable: true, onStop: () => void stopRelogin() });
      const poll = async (): Promise<boolean> => {
        const t = await api<any>(adminUrl("api", "accounts", "relogin", "status"));
        const status = String(t.status || "idle");
        const lines = [
          "重登进度：" + (t.done || 0) + " / " + (t.total || 0) + "（并发 " + (t.concurrency || 1) + "，错峰 " + (t.stagger_ms != null ? t.stagger_ms : 0) + "ms）",
          "成功：" + (t.success || 0) + "，失败：" + (t.failed || 0) + (t.cancelled ? "，已取消：" + t.cancelled : ""),
        ];
        if (t.running && t.message) lines.push("当前：" + (t.email || "-") + " - " + toChineseText(t.message));
        (t.results || []).slice(-12).forEach((item: any) => {
          const tag = item.ok ? "成功" : item.cancelled ? "取消" : "失败";
          lines.push(tag + "  " + (item.email || "-") + (item.error ? " - " + toChineseText(item.error) : ""));
        });
        op.update(lines.join("\n"));
        if (t.running || status === "stopping") return false;
        op.setStopVisible(false);
        window.dispatchEvent(new CustomEvent("accounts:refresh"));
        return true;
      };
      if (await poll()) return;
      reloginTimer = setInterval(() => {
        poll()
          .then((done) => {
            if (done && reloginTimer) {
              clearInterval(reloginTimer);
              reloginTimer = null;
            }
          })
          .catch(() => {
            if (reloginTimer) clearInterval(reloginTimer);
            reloginTimer = null;
            op.setStopVisible(false);
          });
      }, 1000);
    };

    const stopRelogin = async () => {
      await api<any>(adminUrl("api", "accounts", "relogin", "stop"), { method: "POST" }).catch(() => {});
      op.update("停止中：取消未开始任务，正在中断排队中的过盾；已在途的请求会尽快退出。");
    };

    (async () => {
      const restoredProbe = await restoreProbe().catch(() => false);
      if (!restoredProbe) await restoreRelogin().catch(() => {});
    })();

    return () => {
      if (probeTimer) clearInterval(probeTimer);
      if (reloginTimer) clearInterval(reloginTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
