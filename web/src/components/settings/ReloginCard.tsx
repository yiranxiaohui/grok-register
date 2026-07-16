import { useCallback, useEffect, useState } from "react";
import { adminUrl } from "@/lib/adminBase";
import { api } from "@/lib/api";
import { proxyLines } from "@/lib/format";
import { Badge } from "@/components/Badge";
import { useToast } from "@/context/ToastContext";

interface ReloginCfg {
  concurrency?: number;
  stagger_ms?: number;
  proxy_strategy?: string;
  proxy_username?: string;
  proxy_password?: string;
  proxy?: string;
  use_registration_proxy_fallback?: boolean;
}

export function ReloginCard() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<ReloginCfg>({ concurrency: 2, stagger_ms: 200, proxy_strategy: "round_robin", use_registration_proxy_fallback: true });
  const [status, setStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad"; show: boolean }>({ text: "待机", kind: "", show: false });

  const apply = useCallback((c: ReloginCfg) => {
    if (!c) return;
    setCfg({
      concurrency: c.concurrency || 2,
      stagger_ms: c.stagger_ms != null ? c.stagger_ms : 200,
      proxy_strategy: c.proxy_strategy || "round_robin",
      proxy_username: c.proxy_username || "",
      proxy_password: c.proxy_password || "",
      proxy: c.proxy || "",
      use_registration_proxy_fallback: c.use_registration_proxy_fallback !== false,
    });
  }, []);

  useEffect(() => {
    api<{ config: ReloginCfg }>(adminUrl("api", "accounts", "relogin", "config"))
      .then((d) => apply(d.config))
      .catch(() => {});
  }, [apply]);

  const save = () => {
    setStatus({ text: "保存中", kind: "warn", show: true });
    api<{ config: ReloginCfg }>(adminUrl("api", "accounts", "relogin", "config"), {
      method: "PUT",
      body: JSON.stringify({
        concurrency: cfg.concurrency ?? 2,
        stagger_ms: cfg.stagger_ms ?? 200,
        captcha_provider: "local",
        yescaptcha_key: "",
        proxy_strategy: cfg.proxy_strategy || "round_robin",
        proxy_username: (cfg.proxy_username || "").trim(),
        proxy_password: cfg.proxy_password || "",
        proxy: cfg.proxy || "",
        use_registration_proxy_fallback: cfg.use_registration_proxy_fallback !== false,
        use_registration_captcha_fallback: false,
      }),
    })
      .then((d) => {
        apply(d.config);
        setStatus({ text: "已保存", kind: "ok", show: true });
        toast("重登配置已保存");
      })
      .catch((err) => {
        setStatus({ text: "失败", kind: "bad", show: true });
        toast((err as Error).message);
      });
  };

  const proxyCount = proxyLines(cfg.proxy).length;

  return (
    <div className="card-block" style={{ marginTop: 12 }}>
      <div className="section-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
        <div>
          <h3 className="section-title" style={{ fontSize: 14, margin: 0 }}>重登</h3>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={save}>保存</button>
        </div>
      </div>
      <div className="form-grid">
        <div>
          <label htmlFor="relogin_concurrency" title="批量重登时同时处理的账号数；1=串行，最大 10。本地过盾实际会限制到 2">线程</label>
          <input id="relogin_concurrency" type="number" min={1} max={10} value={cfg.concurrency ?? 2} onChange={(e) => setCfg({ ...cfg, concurrency: Number(e.target.value) })} />
        </div>
        <div>
          <label htmlFor="relogin_stagger_ms" title="每启动一个重登任务前等待的毫秒数">错峰（毫秒）</label>
          <input id="relogin_stagger_ms" type="number" min={0} max={60000} value={cfg.stagger_ms ?? 200} onChange={(e) => setCfg({ ...cfg, stagger_ms: Number(e.target.value) })} />
        </div>
        <div>
          <label htmlFor="relogin_proxy_strategy">代理策略</label>
          <select id="relogin_proxy_strategy" value={cfg.proxy_strategy || "round_robin"} onChange={(e) => setCfg({ ...cfg, proxy_strategy: e.target.value })}>
            <option value="round_robin">轮询</option>
            <option value="random">随机</option>
            <option value="sticky">固定首个</option>
          </select>
        </div>
        <div>
          <label htmlFor="relogin_proxy_username">代理用户名</label>
          <input id="relogin_proxy_username" autoComplete="off" value={cfg.proxy_username || ""} onChange={(e) => setCfg({ ...cfg, proxy_username: e.target.value })} />
        </div>
        <div>
          <label htmlFor="relogin_proxy_password">代理密码</label>
          <input id="relogin_proxy_password" type="password" autoComplete="off" value={cfg.proxy_password || ""} onChange={(e) => setCfg({ ...cfg, proxy_password: e.target.value })} />
        </div>
        <div className="span-4">
          <label htmlFor="relogin_proxy">代理池</label>
          <textarea id="relogin_proxy" placeholder="每行一个代理，支持超过 15 个；可留空" spellCheck={false} value={cfg.proxy || ""} onChange={(e) => setCfg({ ...cfg, proxy: e.target.value })} />
          <div className="field-note">已解析 {proxyCount} 个代理</div>
        </div>
        <div className="span-4">
          <label className="check-row" htmlFor="relogin_use_registration_proxy_fallback">
            <input id="relogin_use_registration_proxy_fallback" type="checkbox" checked={cfg.use_registration_proxy_fallback !== false} onChange={(e) => setCfg({ ...cfg, use_registration_proxy_fallback: e.target.checked })} />
            代理池为空时回退使用注册页代理池
          </label>
        </div>
      </div>
      {status.show && <Badge kind={status.kind}>{status.text}</Badge>}
    </div>
  );
}
