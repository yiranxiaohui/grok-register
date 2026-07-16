import { useCallback, useEffect, useRef, useState } from "react";
import { adminUrl } from "@/lib/adminBase";
import { api } from "@/lib/api";
import { normalizeStatus } from "@/lib/status";
import { proxyLines } from "@/lib/format";
import { renderLog, summarizeTask, extractRegCounts } from "@/lib/logRender";
import {
  defaultDraft,
  normalizeMailProvider,
  type ProviderDraft,
} from "@/lib/mailProviders";
import type { MailProvider, RegistrationConfig } from "@/lib/types";
import { MailProviderFields } from "@/components/MailProviderFields";
import { Badge } from "@/components/Badge";
import { Terminal } from "@/components/Terminal";
import { useToast } from "@/context/ToastContext";
import { usePolling } from "@/hooks/usePolling";

interface RegTask {
  type: "batch" | "session";
  id: string;
}

const RUNNING = new Set([
  "running", "starting", "stopping", "registering", "probing",
  "waiting_solver", "solving_turnstile", "queued", "partial",
]);

export function RegisterView() {
  const { toast } = useToast();

  const [provider, setProvider] = useState<MailProvider>("moemail");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [domain, setDomain] = useState("");
  const [expiryMs, setExpiryMs] = useState(3600000);
  const [count, setCount] = useState(1);
  const [staggerMs, setStaggerMs] = useState(100);
  const [probeDelaySec, setProbeDelaySec] = useState(30);
  const [proxyStrategy, setProxyStrategy] = useState("round_robin");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [proxy, setProxy] = useState("");

  // Power-mode-derived values live in Settings; RegisterView carries them through.
  const powerCfg = useRef({ power_mode: false, concurrency: 1, global_inflight: 1, captcha_concurrency: 1 });

  // Per-provider drafts so switching provider doesn't bleed key/domain across.
  const drafts = useRef<Record<string, ProviderDraft>>({
    moemail: defaultDraft("moemail"),
    yyds: defaultDraft("yyds"),
    gptmail: defaultDraft("gptmail"),
    cfmail: defaultDraft("cfmail"),
    duckmail: defaultDraft("duckmail"),
    anymail: defaultDraft("anymail"),
  });

  const [regStatus, setRegStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad" }>({ text: "待机", kind: "" });
  const [taskLabel, setTaskLabel] = useState("--");
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [logData, setLogData] = useState<unknown>("就绪");

  const regTask = useRef<RegTask | null>(null);
  const [polling, setPolling] = useState(false);

  const proxyCount = proxyLines(proxy).length;

  const applyConfig = useCallback((cfg: RegistrationConfig) => {
    const mail = normalizeMailProvider(cfg.mail_provider);
    drafts.current = {
      moemail: { base_url: cfg.moemail_base_url || "", api_key: cfg.moemail_api_key || "", domain: cfg.moemail_domain || "" },
      yyds: { base_url: "https://maliapi.215.im", api_key: cfg.yyds_api_key || "", domain: cfg.yyds_domain || "" },
      gptmail: { base_url: "https://mail.chatgpt.org.uk", api_key: cfg.gptmail_api_key || "", domain: cfg.gptmail_domain || "" },
      cfmail: { base_url: cfg.cfmail_base_url || "", api_key: cfg.cfmail_api_key || "", domain: cfg.cfmail_domain || "" },
      duckmail: { base_url: "https://api.duckmail.sbs", api_key: cfg.duckmail_api_key || "", domain: cfg.duckmail_domain || "" },
      anymail: { base_url: cfg.anymail_base_url || "", api_key: cfg.anymail_api_key || "", domain: cfg.anymail_domain || "" },
    };
    // Active provider may only carry the unified api_key/domain/base_url slots.
    const d = drafts.current[mail];
    if (!d.api_key && cfg.api_key) d.api_key = String(cfg.api_key);
    if (!d.domain && cfg.domain) d.domain = String(cfg.domain);
    if ((mail === "moemail" || mail === "cfmail" || mail === "anymail") && !d.base_url && cfg.base_url) d.base_url = String(cfg.base_url);

    setProvider(mail);
    setBaseUrl(mail === "yyds" || mail === "duckmail" ? defaultDraft(mail).base_url : d.base_url);
    setApiKey(d.api_key);
    setDomain(d.domain);
    setCount(cfg.count == null ? 1 : Number(cfg.count));
    setStaggerMs(cfg.stagger_ms == null ? 100 : Number(cfg.stagger_ms));
    setProbeDelaySec(cfg.probe_delay_sec == null ? 30 : Number(cfg.probe_delay_sec));
    setExpiryMs(cfg.expiry_ms == null ? 3600000 : Number(cfg.expiry_ms));
    setProxy(cfg.proxy || "");
    setProxyUsername(cfg.proxy_username || "");
    setProxyPassword(cfg.proxy_password || "");
    setProxyStrategy(cfg.proxy_strategy || "round_robin");
    powerCfg.current = {
      power_mode: !!cfg.power_mode,
      concurrency: cfg.power_mode ? Number(cfg.concurrency || 1) : 1,
      global_inflight: cfg.power_mode ? Number(cfg.global_inflight || 1) : 1,
      captcha_concurrency: cfg.power_mode ? Number(cfg.captcha_concurrency || 1) : 1,
    };
  }, []);

  // Save the visible fields into the active provider's draft.
  const captureDraft = useCallback((p: MailProvider) => {
    drafts.current[p] = { base_url: baseUrl.trim(), api_key: apiKey, domain: domain.trim() };
  }, [baseUrl, apiKey, domain]);

  const restoreDraft = useCallback((p: MailProvider) => {
    const d = drafts.current[p] || defaultDraft(p);
    if (p === "yyds") setBaseUrl("https://maliapi.215.im");
    else if (p === "duckmail") setBaseUrl("https://api.duckmail.sbs");
    else if (p === "gptmail") setBaseUrl(d.base_url || "https://mail.chatgpt.org.uk");
    else setBaseUrl(d.base_url || "");
    setApiKey(d.api_key || "");
    setDomain(d.domain || "");
  }, []);

  const onProviderChange = useCallback((next: MailProvider) => {
    captureDraft(provider);
    restoreDraft(next);
    setProvider(next);
  }, [provider, captureDraft, restoreDraft]);

  const buildPayload = useCallback((): Record<string, unknown> => {
    const pc = powerCfg.current;
    const payload: Record<string, unknown> = {
      mail_provider: provider,
      captcha_provider: "local",
      yescaptcha_key: "",
      count,
      concurrency: pc.power_mode ? pc.concurrency : 1,
      global_inflight: pc.power_mode ? pc.global_inflight : 1,
      captcha_concurrency: pc.power_mode ? pc.captcha_concurrency : 1,
      power_mode: pc.power_mode,
      stagger_ms: staggerMs,
      probe_delay_sec: probeDelaySec,
      proxy,
      proxy_username: proxyUsername.trim(),
      proxy_password: proxyPassword,
      proxy_strategy: proxyStrategy,
      base_url: baseUrl.trim(),
      api_key: apiKey.trim(),
      domain: domain.trim(),
    };
    if (provider === "moemail" || provider === "cfmail" || provider === "anymail") payload.expiry_ms = expiryMs;
    if (provider === "moemail") {
      payload.moemail_base_url = payload.base_url;
      payload.moemail_api_key = payload.api_key;
      payload.moemail_domain = payload.domain;
    } else if (provider === "yyds") {
      payload.yyds_api_key = payload.api_key;
      payload.yyds_domain = payload.domain;
    } else if (provider === "gptmail") {
      payload.gptmail_api_key = payload.api_key;
      payload.gptmail_domain = payload.domain;
    } else if (provider === "cfmail") {
      payload.cfmail_base_url = payload.base_url;
      payload.cfmail_api_key = payload.api_key;
      payload.cfmail_domain = payload.domain;
    } else if (provider === "duckmail") {
      payload.duckmail_base_url = "https://api.duckmail.sbs";
      payload.duckmail_api_key = payload.api_key;
      payload.duckmail_domain = payload.domain;
      payload.base_url = "https://api.duckmail.sbs";
    } else if (provider === "anymail") {
      payload.anymail_base_url = payload.base_url;
      payload.anymail_api_key = payload.api_key;
      payload.anymail_domain = payload.domain;
    }
    return payload;
  }, [provider, count, staggerMs, probeDelaySec, proxy, proxyUsername, proxyPassword, proxyStrategy, baseUrl, apiKey, domain, expiryMs]);

  const setCounts = (ok: number, fail: number) => {
    setOkCount(Number.isFinite(ok) ? ok : 0);
    setFailCount(Number.isFinite(fail) ? fail : 0);
  };

  const loadConfig = useCallback(async () => {
    const data = await api<{ config: RegistrationConfig }>(adminUrl("api", "accounts", "register-email", "config"));
    applyConfig(data.config);
  }, [applyConfig]);

  useEffect(() => {
    loadConfig().catch((err) => {
      setRegStatus({ text: "初始化失败", kind: "bad" });
      setLogData((err as Error).message);
    });
  }, [loadConfig]);

  // On mount, reconnect to any registration task still running server-side
  // (survives page reload). Only resumes if a live task is found.
  useEffect(() => {
    if (regTask.current) return;
    api<any>(adminUrl("api", "accounts", "register-email", "sessions"))
      .then((sessions) => {
        const picked = pickLiveTask(sessions);
        if (!picked || !picked.id) return;
        const st = String((picked.raw && (picked.raw.status || picked.raw.batch_status)) || "").toLowerCase();
        const running = RUNNING.has(st) || Number((picked.raw && picked.raw.running) || 0) > 0;
        if (!running) return;
        regTask.current = { type: picked.type, id: picked.id };
        setTaskLabel(picked.id);
        setRegStatus({ text: "恢复中", kind: "warn" });
        setPolling(true);
      })
      .catch(() => {});
  }, []);

  const saveConfig = async () => {
    setRegStatus({ text: "保存中", kind: "warn" });
    const data = await api<{ config: RegistrationConfig; message?: string }>(
      adminUrl("api", "accounts", "register-email", "config"),
      { method: "PUT", body: JSON.stringify(buildPayload()) },
    );
    applyConfig(data.config);
    setRegStatus({ text: "已保存", kind: "ok" });
    setLogData(data);
    toast(data.message || "配置已保存");
  };

  const preflight = async () => {
    setRegStatus({ text: "自检中", kind: "warn" });
    const data = await api<{ ok: boolean }>(adminUrl("api", "accounts", "register-email", "preflight"), {
      method: "POST",
      body: JSON.stringify(buildPayload()),
    });
    setRegStatus({ text: data.ok ? "自检通过" : "自检失败", kind: data.ok ? "ok" : "bad" });
    setLogData(data);
  };

  const startSolver = async () => {
    setRegStatus({ text: "启动过盾中", kind: "warn" });
    const data = await api<{ ok?: boolean }>(adminUrl("api", "local-solver", "start"), {
      method: "POST",
      body: JSON.stringify({ thread: 1, browser_type: "camoufox" }),
    });
    setRegStatus({ text: data.ok === false ? "过盾失败" : "过盾已启动", kind: data.ok === false ? "bad" : "ok" });
    setLogData(data);
  };

  const testProxy = async () => {
    setRegStatus({ text: "代理测试中", kind: "warn" });
    const data = await api<{ tested?: number; available?: number; ok?: boolean }>(
      adminUrl("api", "accounts", "register-email", "test-proxy"),
      { method: "POST", body: JSON.stringify(buildPayload()) },
    );
    const tested = Number(data.tested || 0);
    setRegStatus({
      text: tested ? `代理可用 ${Number(data.available || 0)} / ${tested}` : "代理失败",
      kind: data.ok ? "ok" : "bad",
    });
    setLogData(data);
  };

  const pollOnce = useCallback(async (): Promise<boolean> => {
    const task = regTask.current;
    if (!task) return true;
    const path =
      task.type === "batch"
        ? adminUrl("api", "accounts", "register-email", "batches", task.id)
        : adminUrl("api", "accounts", "register-email", "sessions", task.id);
    const data = await api<any>(path);
    const state = normalizeStatus(data.status || data.batch_status || "running");
    setRegStatus({ text: state.label, kind: state.kind });
    setTaskLabel(task.id);
    const counts = extractRegCounts(data);
    setCounts(counts.ok, counts.fail);
    setLogData(summarizeTask(data));
    if (state.terminal) {
      setPolling(false);
      window.dispatchEvent(new CustomEvent("accounts:refresh"));
      return true;
    }
    return false;
  }, []);

  usePolling(polling, 2500, pollOnce);

  const startRegistration = async () => {
    setPolling(false);
    setRegStatus({ text: "启动中", kind: "warn" });
    setTaskLabel("启动中");
    setCounts(0, 0);
    const data = await api<any>(adminUrl("api", "accounts", "register-email"), {
      method: "POST",
      body: JSON.stringify(buildPayload()),
    });
    if (data.batch_id) regTask.current = { type: "batch", id: data.batch_id };
    else if (data.id) regTask.current = { type: "session", id: data.id };
    else regTask.current = null;
    setTaskLabel(regTask.current ? regTask.current.id : "--");
    setRegStatus({ text: normalizeStatus(data.status || "running").label, kind: "warn" });
    const counts = extractRegCounts(data);
    setCounts(counts.ok, counts.fail);
    setLogData(data);
    if (regTask.current) setPolling(true);
    window.dispatchEvent(new CustomEvent("accounts:refresh"));
  };

  const stopRegistration = async () => {
    const data = await api<any>(adminUrl("api", "accounts", "register-email", "stop"), {
      method: "POST",
      body: "{}",
    });
    setRegStatus({ text: "已停止", kind: "bad" });
    setLogData(data);
    setPolling(false);
    window.dispatchEvent(new CustomEvent("accounts:refresh"));
  };

  const refreshRegistration = async () => {
    if (!regTask.current) {
      const sessions = await api<any>(adminUrl("api", "accounts", "register-email", "sessions"));
      const picked = pickLiveTask(sessions);
      if (picked && picked.id) {
        regTask.current = { type: picked.type, id: picked.id };
      } else {
        setRegStatus({ text: "待机", kind: "" });
        setTaskLabel("--");
        setCounts(0, 0);
        setLogData(sessions);
        return;
      }
    }
    setPolling(true);
  };

  const runAction = (fn: () => Promise<void>, target = "reg") => {
    fn().catch((err) => {
      setRegStatus({ text: "失败", kind: "bad" });
      setLogData((err as { payload?: unknown }).payload || (err as Error).message);
      toast((err as Error).message);
      void target;
    });
  };

  const onLogAction = (action: "start-solver") => {
    if (action === "start-solver") {
      startSolver().then(preflight).catch((err) => {
        setRegStatus({ text: "处理失败", kind: "bad" });
        setLogData((err as Error).message);
        toast((err as Error).message);
      });
    }
  };

  return (
    <div id="view-register" className="view active">
      <div className="grid register-grid">
        <section className="section register-section" aria-labelledby="reg-title">
          <div className="section-head">
            <div>
              <h2 id="reg-title" className="section-title">协议注册</h2>
              <p className="section-desc">邮箱、过盾、代理与批量参数。</p>
            </div>
            <div className="actions">
              <button className="btn" type="button" onClick={() => runAction(saveConfig)}>保存</button>
              <button className="btn" type="button" onClick={() => runAction(preflight)}>自检</button>
              <button className="btn" type="button" onClick={() => runAction(startSolver)}>启动过盾</button>
              <button className="btn" type="button" onClick={() => runAction(testProxy)}>测代理</button>
              <button className="btn primary" type="button" onClick={() => runAction(startRegistration)}>开始</button>
              <button className="btn danger" type="button" onClick={() => runAction(stopRegistration)}>停止</button>
              <button className="btn ghost" type="button" onClick={() => runAction(refreshRegistration)}>刷新</button>
            </div>
          </div>
          <div className="section-body register-layout">
            <div className="register-form-panel">
              <div className="form-grid">
                <MailProviderFields
                  provider={provider}
                  baseUrl={baseUrl}
                  apiKey={apiKey}
                  domain={domain}
                  expiryMs={expiryMs}
                  onProviderChange={onProviderChange}
                  onBaseUrlChange={setBaseUrl}
                  onApiKeyChange={setApiKey}
                  onDomainChange={setDomain}
                  onExpiryChange={setExpiryMs}
                />
                <div>
                  <label htmlFor="count">数量</label>
                  <input id="count" type="number" min={1} value={count} onChange={(e) => setCount(Number(e.target.value))} />
                </div>
                <div className="span-4">
                  <label>并发策略</label>
                  <div className="field-note" style={{ lineHeight: 1.55, padding: "10px 12px", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, background: "rgba(255,255,255,.03)" }}>
                    {powerCfg.current.power_mode
                      ? `强力模式已开启：线程 ${powerCfg.current.concurrency} / 过盾浏览器 ${powerCfg.current.captcha_concurrency} / 全局 ${powerCfg.current.global_inflight}。可在设置调整。`
                      : "安全模式：线程 1 / 过盾 1 / 全局 1。若需高并发，请到设置 → 强力模式开启。"}
                  </div>
                </div>
                <div>
                  <label htmlFor="stagger_ms">错峰（毫秒）</label>
                  <input id="stagger_ms" type="number" min={0} value={staggerMs} onChange={(e) => setStaggerMs(Number(e.target.value))} />
                </div>
                <div>
                  <label htmlFor="probe_delay_sec" title="新账号入池后等待多少秒再自动测活；0=立即测活。新号刚注册完上游常短暂 403，建议 30 秒">测活等待（秒）</label>
                  <input id="probe_delay_sec" type="number" min={0} max={600} step={1} value={probeDelaySec} onChange={(e) => setProbeDelaySec(Number(e.target.value))} />
                </div>
                <div>
                  <label htmlFor="proxy_strategy">代理策略</label>
                  <select id="proxy_strategy" value={proxyStrategy} onChange={(e) => setProxyStrategy(e.target.value)}>
                    <option value="round_robin">轮询</option>
                    <option value="random">随机</option>
                    <option value="sticky">固定首个</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="proxy_username">代理用户名</label>
                  <input id="proxy_username" autoComplete="off" value={proxyUsername} onChange={(e) => setProxyUsername(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="proxy_password">代理密码</label>
                  <input id="proxy_password" type="password" autoComplete="off" value={proxyPassword} onChange={(e) => setProxyPassword(e.target.value)} />
                </div>
                <div className="span-4">
                  <label htmlFor="proxy">代理池</label>
                  <textarea id="proxy" placeholder="每行一个代理，支持超过 15 个；可留空" spellCheck={false} value={proxy} onChange={(e) => setProxy(e.target.value)} />
                  <div className="field-note">已解析 {proxyCount} 个代理</div>
                </div>
              </div>
            </div>
            <div className="register-log-panel">
              <div className="log-panel-head">
                <p className="log-panel-title">运行日志</p>
                <div className="status-row">
                  <Badge kind={regStatus.kind}>{regStatus.text}</Badge>
                  <Badge>任务：{taskLabel}</Badge>
                  <Badge kind="ok">成功：{okCount}</Badge>
                  <Badge kind={failCount > 0 ? "bad" : ""}>失败：{failCount}</Badge>
                </div>
              </div>
              <Terminal content={renderLog("reg-log", logData, onLogAction)} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function pickLiveTask(sessions: any): { type: "batch" | "session"; id: string; raw: any } | null {
  const batches = sessions.batches || [];
  const sess = sessions.sessions || [];
  for (const b of batches) {
    const st = String(b.status || b.batch_status || "").toLowerCase();
    if (RUNNING.has(st) || Number(b.running || 0) > 0) return { type: "batch", id: b.id || b.batch_id, raw: b };
  }
  for (const s of sess) {
    const st = String(s.status || "").toLowerCase();
    if (RUNNING.has(st)) return { type: "session", id: s.id, raw: s };
  }
  if (batches[0]) return { type: "batch", id: batches[0].id || batches[0].batch_id, raw: batches[0] };
  if (sess[0]) return { type: "session", id: sess[0].id, raw: sess[0] };
  return null;
}
