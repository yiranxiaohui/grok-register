import { useCallback, useEffect, useState } from "react";
import { adminUrl } from "@/lib/adminBase";
import { api } from "@/lib/api";
import { Badge } from "@/components/Badge";
import { useToast } from "@/context/ToastContext";
import type { RegistrationConfig } from "@/lib/types";

const PRESETS = [
  { c: 1, cap: 1, g: 1 },
  { c: 5, cap: 5, g: 8 },
  { c: 10, cap: 10, g: 20 },
  { c: 20, cap: 20, g: 30 },
];

export function PowerModeCard() {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [concurrency, setConcurrency] = useState(1);
  const [captcha, setCaptcha] = useState(1);
  const [global, setGlobal] = useState(1);
  const [status, setStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad"; show: boolean }>({ text: "待机", kind: "", show: false });

  const apply = useCallback((cfg: RegistrationConfig) => {
    const on = !!cfg.power_mode;
    setEnabled(on);
    setConcurrency(cfg.concurrency == null ? 1 : Number(cfg.concurrency));
    setCaptcha(cfg.captcha_concurrency == null ? 1 : Number(cfg.captcha_concurrency));
    setGlobal(cfg.global_inflight == null ? 1 : Number(cfg.global_inflight));
  }, []);

  useEffect(() => {
    api<{ config: RegistrationConfig }>(adminUrl("api", "accounts", "register-email", "config"))
      .then((d) => apply(d.config))
      .catch(() => {});
  }, [apply]);

  const save = async () => {
    setStatus({ text: "保存中", kind: "warn", show: true });
    const payload = {
      power_mode: enabled,
      concurrency: enabled ? concurrency : 1,
      captcha_concurrency: enabled ? captcha : 1,
      global_inflight: enabled ? global : 1,
    };
    if (enabled && payload.captcha_concurrency > 20) {
      if (!window.confirm("过盾浏览器数=" + payload.captcha_concurrency + " 很高，可能导致内存爆、机器卡死。确定保存？")) {
        setStatus({ text: "已取消", kind: "", show: true });
        return;
      }
    }
    const data = await api<{ config?: RegistrationConfig; solver?: any }>(adminUrl("api", "accounts", "register-email", "config"), {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    apply(data.config || (payload as RegistrationConfig));
    setStatus({ text: "已保存", kind: "ok", show: true });
    let solverMsg = "";
    if (data.solver) {
      if (data.solver.resized || data.solver.restarted) {
        solverMsg = data.solver.ok
          ? "；过盾已热加载 " + (data.solver.thread || payload.captcha_concurrency) + " 浏览器"
          : "；过盾热加载失败 " + (data.solver.error || "");
      } else if (data.solver.ok && data.solver.method === "noop") {
        solverMsg = "；过盾已是 " + (data.solver.thread || payload.captcha_concurrency) + " 浏览器";
      }
    }
    toast(enabled ? "强力模式已保存：线程 " + payload.concurrency + " / 过盾 " + payload.captcha_concurrency + " / 全局 " + payload.global_inflight + solverMsg : "已关闭强力模式，恢复 1/1/1" + solverMsg);
  };

  const disabled = !enabled;

  return (
    <div className="card-block" style={{ marginTop: 12 }}>
      <div className="section-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
        <div>
          <h3 className="section-title" style={{ fontSize: 14, margin: 0 }}>强力模式（高并发）</h3>
          <p className="section-desc" style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.75 }}>默认安全 1 线程 / 1 过盾浏览器。开启后可多开浏览器过盾；仅建议本机高性能机器使用。</p>
        </div>
        <div className="header-checks">
          <label className="header-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            启用强力模式
          </label>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={() => save().catch((err) => { setStatus({ text: "保存失败", kind: "bad", show: true }); toast((err as Error).message || "强力模式保存失败"); })}>保存并发</button>
        </div>
      </div>
      {enabled && (
        <div className="field-note" style={{ margin: "0 0 10px", padding: "10px 12px", border: "1px solid rgba(255,120,80,.35)", borderRadius: 10, background: "rgba(255,80,40,.08)", color: "#ffb4a0", lineHeight: 1.55 }}>
          <strong>注意：</strong>过盾浏览器与注册线程会占用 CPU/内存；机器越弱，可开的并发越少。请按本机资源自行调整。
        </div>
      )}
      <div className="form-grid" style={{ opacity: enabled ? 1 : 0.55 }}>
        <div>
          <label htmlFor="power_concurrency" title="单批注册 worker 数">线程</label>
          <input id="power_concurrency" type="number" min={1} max={50} value={concurrency} disabled={disabled} onChange={(e) => setConcurrency(Number(e.target.value))} />
        </div>
        <div>
          <label htmlFor="power_captcha_concurrency" title="同时开几个 Camoufox 过盾">过盾浏览器数</label>
          <input id="power_captcha_concurrency" type="number" min={1} max={50} value={captcha} disabled={disabled} onChange={(e) => setCaptcha(Number(e.target.value))} />
        </div>
        <div>
          <label htmlFor="power_global_inflight" title="全机所有批次合计同时注册上限">全局同时注册上限</label>
          <input id="power_global_inflight" type="number" min={1} max={64} value={global} disabled={disabled} onChange={(e) => setGlobal(Number(e.target.value))} />
        </div>
        <div className="span-4">
          <label>快捷填入</label>
          <div className="actions" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
            {PRESETS.map((p) => (
              <button key={`${p.c}-${p.cap}-${p.g}`} type="button" className="btn ghost power-preset" onClick={() => { setEnabled(true); setConcurrency(p.c); setCaptcha(p.cap); setGlobal(p.g); }}>
                {p.c}/{p.cap}/{p.g}
              </button>
            ))}
          </div>
          <div className="field-note" style={{ marginTop: 8, color: captcha > 20 || global < concurrency ? "#ffb4a0" : undefined }}>
            {hint(concurrency, captcha, global)}
          </div>
        </div>
      </div>
      {status.show && <Badge kind={status.kind}>{status.text}</Badge>}
    </div>
  );
}

function hint(c: number, cap: number, g: number): string {
  const tips: string[] = [];
  if (c !== cap) tips.push("线程与过盾浏览器数不一致：过盾阶段会按较小者排队");
  if (g < c) tips.push("全局上限小于线程：实际并发会被全局上限卡住");
  if (cap > 20) tips.push("过盾浏览器数较高，CPU/内存压力会明显上升");
  if (!tips.length) tips.push("线程 ≈ 过盾浏览器数；全局上限 ≥ 线程。保存后会自动热加载过盾浏览器池。");
  return tips.join("；");
}
