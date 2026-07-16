import { useCallback, useEffect, useRef, useState } from "react";
import { adminUrl } from "@/lib/adminBase";
import { api } from "@/lib/api";
import { formatTs } from "@/lib/format";
import { renderLog } from "@/lib/logRender";
import { Badge } from "@/components/Badge";
import { Terminal } from "@/components/Terminal";
import { useToast } from "@/context/ToastContext";

interface Policy {
  enabled?: boolean;
  interval_min?: number;
  batch_count?: number;
  window_start_hour?: number;
  window_end_hour?: number;
  skip_if_running?: boolean;
  fallback_enabled?: boolean;
  rotate_proxy_on_fail?: boolean;
  rotate_domain_on_fail?: boolean;
  rotate_mail_provider_on_fail?: boolean;
  fail_threshold?: number;
  fail_window_sec?: number;
  min_concurrency?: number;
  min_global_inflight?: number;
  min_probe_delay_sec?: number;
  concurrency_step_down?: number;
  global_inflight_step_down?: number;
  probe_delay_step_up?: number;
  sys_guard_enabled?: boolean;
  cpu_high_pct?: number;
  mem_high_pct?: number;
  cpu_critical_pct?: number;
  mem_critical_pct?: number;
  throttle_cooldown_sec?: number;
  recover_after_sec?: number;
  recover_step_up?: number;
}

const DEFAULTS: Required<Policy> = {
  enabled: false, interval_min: 30, batch_count: 10, window_start_hour: 0, window_end_hour: 24,
  skip_if_running: true, fallback_enabled: true, rotate_proxy_on_fail: true, rotate_domain_on_fail: true,
  rotate_mail_provider_on_fail: false, fail_threshold: 3, fail_window_sec: 300, min_concurrency: 1,
  min_global_inflight: 1, min_probe_delay_sec: 5, concurrency_step_down: 1, global_inflight_step_down: 1,
  probe_delay_step_up: 1, sys_guard_enabled: true, cpu_high_pct: 85, mem_high_pct: 88, cpu_critical_pct: 95,
  mem_critical_pct: 95, throttle_cooldown_sec: 60, recover_after_sec: 300, recover_step_up: 1,
};

export function ScheduleCard({ active }: { active: boolean }) {
  const { toast } = useToast();
  const [pol, setPol] = useState<Required<Policy>>(DEFAULTS);
  const [status, setStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad" }>({ text: "待机", kind: "" });
  const [sysText, setSysText] = useState("系统：--");
  const [effText, setEffText] = useState("有效：--");
  const [nextText, setNextText] = useState("下次：--");
  const [logData, setLogData] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setPol((p) => ({ ...p, [k]: v as never }));
  const num = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);
  const chk = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.checked as never);

  const applyPolicy = useCallback((p: Policy) => {
    if (!p) return;
    setPol({ ...DEFAULTS, ...p, enabled: !!p.enabled });
  }, []);

  const applyStatus = useCallback((st: any) => {
    if (!st) return;
    if (st.policy) applyPolicy(st.policy);
    const p = st.policy || {};
    const rt = st.runtime || {};
    const reg = st.registration || {};
    const sys = st.system || {};
    const enabled = !!p.enabled;
    const running = !!st.registration_running;
    let badge = enabled ? (running ? "运行中" : "已启用") : "未启用";
    let kind: "" | "ok" | "warn" | "bad" = enabled ? (running ? "warn" : "ok") : "";
    if (rt.last_error) { badge = "异常"; kind = "bad"; }
    setStatus({ text: badge, kind });
    const cpu = sys.ok ? Number(sys.cpu_pct || 0).toFixed(0) + "%" : "--";
    const mem = sys.ok ? Number(sys.mem_pct || 0).toFixed(0) + "%" : "--";
    setSysText("系统：CPU " + cpu + " / MEM " + mem);
    setEffText(
      "有效：线程 " + (reg.concurrency != null ? reg.concurrency : "--") +
        " / 全局 " + (reg.global_inflight != null ? reg.global_inflight : "--") +
        " / 测活 " + (reg.probe_delay_sec != null ? reg.probe_delay_sec : "--") + "s" +
        " · 失败 " + (st.recent_failures != null ? st.recent_failures : 0),
    );
    let nt = "下次：--";
    if (!enabled) nt = "下次：未启用";
    else if (!st.in_window) nt = "下次：不在时段";
    else if (st.seconds_to_next != null) nt = "下次：" + st.seconds_to_next + "s";
    else if (st.next_due_at) nt = "下次：" + formatTs(st.next_due_at);
    else nt = "下次：即将";
    if (rt.last_action) nt += " · " + String(rt.last_action).slice(0, 48);
    setNextText(nt);
  }, [applyPolicy]);

  const loadStatus = useCallback(async () => {
    const data = await api<any>(adminUrl("api", "schedule", "status"));
    applyStatus(data);
    return data;
  }, [applyStatus]);

  useEffect(() => {
    if (!active) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    loadStatus().catch(() => setStatus({ text: "加载失败", kind: "bad" }));
    timer.current = setInterval(() => loadStatus().catch(() => {}), 15000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [active, loadStatus]);

  const payload = (): Policy => ({ ...pol });

  const save = async () => {
    setStatus({ text: "保存中", kind: "warn" });
    const data = await api<any>(adminUrl("api", "schedule", "policy"), { method: "PUT", body: JSON.stringify(payload()) });
    applyPolicy(data.policy);
    setStatus({ text: "已保存", kind: "ok" });
    setLogData(data);
    toast(data.message || "定时策略已保存");
    await loadStatus().catch(() => {});
  };

  const runNow = async () => {
    setStatus({ text: "触发中", kind: "warn" });
    const data = await api<any>(adminUrl("api", "schedule", "run-now"), { method: "POST", body: "{}" });
    setLogData(data);
    if (data.started) {
      setStatus({ text: "已启动", kind: "ok" });
      toast("定时批次已启动 " + (data.batch_id || ""));
    } else {
      setStatus({ text: data.skipped || "未启动", kind: data.ok === false ? "bad" : "warn" });
      toast(data.error || "跳过：" + (data.skipped || "unknown"));
    }
    if (data.status) applyStatus(data.status);
    else await loadStatus();
  };

  const resetThrottle = async () => {
    setStatus({ text: "恢复中", kind: "warn" });
    const data = await api<any>(adminUrl("api", "schedule", "reset-throttle"), { method: "POST", body: "{}" });
    setLogData(data);
    setStatus({ text: "已恢复基线", kind: "ok" });
    toast("已恢复并发/测活基线并清空失败记录");
    await loadStatus().catch(() => {});
  };

  const run = (fn: () => Promise<void>) => fn().catch((err) => { setStatus({ text: "失败", kind: "bad" }); toast((err as Error).message); });

  return (
    <div className="card-block" style={{ marginTop: 12 }}>
      <div className="section-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
        <div>
          <h3 className="section-title" style={{ fontSize: 14, margin: 0 }}>定时注册策略</h3>
          <p className="section-desc" style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.75 }}>按间隔自动注册；失败轮换代理/域名；系统压力升高时降并发与测活节奏。</p>
        </div>
        <div className="header-checks">
          <label className="header-check">
            <input type="checkbox" checked={pol.enabled} onChange={chk("enabled")} />
            启用定时
          </label>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={() => run(save)}>保存</button>
          <button className="btn" type="button" onClick={() => run(runNow)}>立即执行</button>
          <button className="btn ghost" type="button" onClick={() => run(resetThrottle)}>恢复基线</button>
        </div>
      </div>
      <div className="form-grid">
        <NumField id="schedule_interval_min" label="间隔（分钟）" title="两次自动批次之间的最短间隔（分钟）" min={1} max={1440} value={pol.interval_min} onChange={num("interval_min")} />
        <NumField id="schedule_batch_count" label="每批数量" title="每次定时启动注册的数量" min={1} max={1000} value={pol.batch_count} onChange={num("batch_count")} />
        <NumField id="schedule_window_start_hour" label="时段起（时）" min={0} max={23} value={pol.window_start_hour} onChange={num("window_start_hour")} />
        <NumField id="schedule_window_end_hour" label="时段止（时）" min={0} max={24} value={pol.window_end_hour} onChange={num("window_end_hour")} />
        <div className="span-4">
          <label className="check-row"><input type="checkbox" checked={pol.skip_if_running} onChange={chk("skip_if_running")} />已有注册任务时跳过（不叠批）</label>
        </div>
        <div className="span-4" style={{ marginTop: 4 }}><strong style={{ fontSize: 12, opacity: 0.8 }}>失败回退</strong></div>
        <div className="span-4">
          <label className="check-row"><input type="checkbox" checked={pol.fallback_enabled} onChange={chk("fallback_enabled")} />启用失败回退</label>
        </div>
        <div><label className="check-row"><input type="checkbox" checked={pol.rotate_proxy_on_fail} onChange={chk("rotate_proxy_on_fail")} />失败换代理</label></div>
        <div><label className="check-row"><input type="checkbox" checked={pol.rotate_domain_on_fail} onChange={chk("rotate_domain_on_fail")} />失败换域名</label></div>
        <div><label className="check-row"><input type="checkbox" checked={pol.rotate_mail_provider_on_fail} onChange={chk("rotate_mail_provider_on_fail")} />失败换邮箱服务</label></div>
        <NumField id="schedule_fail_threshold" label="失败阈值" title="滚动窗口内失败次数达到后开始降并发" min={1} max={50} value={pol.fail_threshold} onChange={num("fail_threshold")} />
        <NumField id="schedule_fail_window_sec" label="失败窗口（秒）" min={30} max={3600} value={pol.fail_window_sec} onChange={num("fail_window_sec")} />
        <div className="span-4" style={{ marginTop: 4 }}><strong style={{ fontSize: 12, opacity: 0.8 }}>降载 / 测活节奏</strong></div>
        <NumField id="schedule_min_concurrency" label="最低线程" min={1} max={20} value={pol.min_concurrency} onChange={num("min_concurrency")} />
        <NumField id="schedule_min_global_inflight" label="最低全局上限" min={1} max={64} value={pol.min_global_inflight} onChange={num("min_global_inflight")} />
        <NumField id="schedule_min_probe_delay_sec" label="最低测活等待" title="降载时测活等待的下限（秒）" min={0} max={600} value={pol.min_probe_delay_sec} onChange={num("min_probe_delay_sec")} />
        <NumField id="schedule_concurrency_step_down" label="线程步进↓" min={1} max={10} value={pol.concurrency_step_down} onChange={num("concurrency_step_down")} />
        <NumField id="schedule_global_inflight_step_down" label="全局上限步进↓" min={1} max={16} value={pol.global_inflight_step_down} onChange={num("global_inflight_step_down")} />
        <NumField id="schedule_probe_delay_step_up" label="测活等待步进↑" title="降载时测活等待每次增加的秒数" min={0} max={120} value={pol.probe_delay_step_up} onChange={num("probe_delay_step_up")} />
        <div className="span-4" style={{ marginTop: 4 }}><strong style={{ fontSize: 12, opacity: 0.8 }}>系统护栏</strong></div>
        <div className="span-4">
          <label className="check-row"><input type="checkbox" checked={pol.sys_guard_enabled} onChange={chk("sys_guard_enabled")} />监控 CPU/内存，触顶立即降并发（含手动高并发）</label>
        </div>
        <NumField id="schedule_cpu_high_pct" label="CPU 高压 %" min={20} max={99} value={pol.cpu_high_pct} onChange={num("cpu_high_pct")} />
        <NumField id="schedule_mem_high_pct" label="内存高压 %" min={20} max={99} value={pol.mem_high_pct} onChange={num("mem_high_pct")} />
        <NumField id="schedule_cpu_critical_pct" label="CPU 触顶 %" min={20} max={99} value={pol.cpu_critical_pct} onChange={num("cpu_critical_pct")} />
        <NumField id="schedule_mem_critical_pct" label="内存触顶 %" min={20} max={99} value={pol.mem_critical_pct} onChange={num("mem_critical_pct")} />
        <NumField id="schedule_throttle_cooldown_sec" label="降载冷却（秒）" min={10} max={1800} value={pol.throttle_cooldown_sec} onChange={num("throttle_cooldown_sec")} />
        <NumField id="schedule_recover_after_sec" label="恢复观察（秒）" min={30} max={7200} value={pol.recover_after_sec} onChange={num("recover_after_sec")} />
        <NumField id="schedule_recover_step_up" label="恢复步进↑" min={1} max={10} value={pol.recover_step_up} onChange={num("recover_step_up")} />
      </div>
      <div className="summary-row" style={{ marginTop: 10, flexWrap: "wrap", gap: 6 }}>
        <Badge kind={status.kind}>{status.text}</Badge>
        <Badge>{sysText}</Badge>
        <Badge>{effText}</Badge>
        <Badge>{nextText}</Badge>
      </div>
      {logData != null && <Terminal className="compact" content={renderLog("schedule-log", logData)} style={{ marginTop: 8 }} />}
    </div>
  );
}

function NumField({ id, label, title, min, max, value, onChange }: { id: string; label: string; title?: string; min: number; max: number; value: number; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <div>
      <label htmlFor={id} title={title}>{label}</label>
      <input id={id} type="number" min={min} max={max} value={value} onChange={onChange} />
    </div>
  );
}
