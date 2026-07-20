import { useCallback, useEffect, useRef, useState } from "react";
import { adminUrl } from "@/lib/adminBase";
import { api } from "@/lib/api";
import { renderLog } from "@/lib/logRender";
import { Badge } from "@/components/Badge";
import { Terminal } from "@/components/Terminal";
import { useToast } from "@/context/ToastContext";

type Backend = "" | "grok2api" | "cpa" | "sub2api";

interface Grok2apiCfg {
  base_url?: string;
  username?: string;
  password?: string;
  upload_mode?: string;
  limit?: number;
  upload_batch_size?: number;
  auto_upload_after_probe?: boolean;
  auto_upload_after_relogin?: boolean;
}
interface CpaCfg {
  base_url?: string;
  management_key?: string;
  limit?: number;
  auto_upload_after_probe?: boolean;
  auto_upload_after_relogin?: boolean;
  auto_delete_abnormal?: boolean;
  auto_delete_min_interval_sec?: number;
}
interface Sub2apiCfg {
  base_url?: string;
  api_key?: string;
  limit?: number;
  sync_proxies?: boolean;
  auto_upload_after_probe?: boolean;
  auto_upload_after_relogin?: boolean;
}

const isMask = (v: string) => /^\*+$/.test(String(v || "").trim());

// The three remote cards share mutual-exclusion state (only one backend may
// auto-import). Kept in one component so enforceExclusiveAutoUpload can reach both.
export function RemoteCards() {
  const { toast } = useToast();

  const [backend, setBackend] = useState<Backend>("");
  const [backendStatus, setBackendStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad"; show: boolean }>({ text: "未锁定", kind: "", show: false });

  const [g, setG] = useState<Grok2apiCfg>({ upload_mode: "build_auth_files", limit: 1000, upload_batch_size: 1 });
  const [gProbe, setGProbe] = useState(false);
  const [gRelogin, setGRelogin] = useState(false);
  const [gStatus, setGStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad"; show: boolean }>({ text: "待机", kind: "", show: false });
  const [gLog, setGLog] = useState<unknown>(null);

  const [c, setC] = useState<CpaCfg>({ limit: 1000 });
  const [cProbe, setCProbe] = useState(false);
  const [cRelogin, setCRelogin] = useState(false);
  const [cAutoDelete, setCAutoDelete] = useState(false);
  const [cStatus, setCStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad"; show: boolean }>({ text: "待机", kind: "", show: false });
  const [cLog, setCLog] = useState<unknown>(null);

  const [s, setS] = useState<Sub2apiCfg>({ limit: 1000, sync_proxies: true });
  const [sProbe, setSProbe] = useState(false);
  const [sRelogin, setSRelogin] = useState(false);
  const [sStatus, setSStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad"; show: boolean }>({ text: "待机", kind: "", show: false });
  const [sLog, setSLog] = useState<unknown>(null);

  const backendRef = useRef<Backend>("");
  backendRef.current = backend;

  // UI-level mutual exclusion. source picks the winning side.
  const enforceExclusive = useCallback(
    (source: "grok2api" | "cpa" | "sub2api" | "load",
     next?: { gp?: boolean; gr?: boolean; cp?: boolean; cr?: boolean; sp?: boolean; sr?: boolean }) => {
      const gOn = (next?.gp ?? gProbe) || (next?.gr ?? gRelogin);
      const cOn = (next?.cp ?? cProbe) || (next?.cr ?? cRelogin);
      const sOn = (next?.sp ?? sProbe) || (next?.sr ?? sRelogin);
      const clearG = () => { setGProbe(false); setGRelogin(false); };
      const clearC = () => { setCProbe(false); setCRelogin(false); };
      const clearS = () => { setSProbe(false); setSRelogin(false); };
      if (source === "grok2api" && gOn) { clearC(); clearS(); setBackend("grok2api"); return; }
      if (source === "cpa" && cOn) { clearG(); clearS(); setBackend("cpa"); return; }
      if (source === "sub2api" && sOn) { clearG(); clearC(); setBackend("sub2api"); return; }
      // load / 无明确来源：多者并存时按 pin 或优先级留一个
      const on = [["grok2api", gOn], ["cpa", cOn], ["sub2api", sOn]].filter(([, v]) => v).map(([k]) => k as Backend);
      if (on.length <= 1) {
        if (on.length === 1) setBackend(on[0]);
        return;
      }
      const pinned = backendRef.current;
      const keep = pinned && on.includes(pinned) ? pinned : on[0];
      if (keep !== "grok2api") clearG();
      if (keep !== "cpa") clearC();
      if (keep !== "sub2api") clearS();
      setBackend(keep);
    },
    [gProbe, gRelogin, cProbe, cRelogin, sProbe, sRelogin],
  );

  const applyGrok2api = useCallback((cfg: Grok2apiCfg) => {
    cfg = cfg || {};
    setG({
      base_url: cfg.base_url || "",
      username: cfg.username || "",
      password: isMask(cfg.password || "") ? "" : cfg.password || "",
      upload_mode: cfg.upload_mode || "build_auth_files",
      limit: cfg.limit == null ? 1000 : cfg.limit,
      upload_batch_size: cfg.upload_batch_size == null ? 1 : cfg.upload_batch_size,
    });
    setGProbe(!!cfg.auto_upload_after_probe);
    setGRelogin(!!cfg.auto_upload_after_relogin);
  }, []);

  const applyCpa = useCallback((cfg: CpaCfg) => {
    cfg = cfg || {};
    setC({
      base_url: cfg.base_url || "",
      management_key: isMask(cfg.management_key || "") ? "" : cfg.management_key || "",
      limit: cfg.limit == null ? 1000 : cfg.limit,
    });
    setCProbe(!!cfg.auto_upload_after_probe);
    setCRelogin(!!cfg.auto_upload_after_relogin);
    setCAutoDelete(!!cfg.auto_delete_abnormal);
  }, []);

  const applySub2api = useCallback((cfg: Sub2apiCfg) => {
    cfg = cfg || {};
    setS({
      base_url: cfg.base_url || "",
      api_key: isMask(cfg.api_key || "") ? "" : cfg.api_key || "",
      limit: cfg.limit == null ? 1000 : cfg.limit,
      sync_proxies: cfg.sync_proxies !== false,
    });
    setSProbe(!!cfg.auto_upload_after_probe);
    setSRelogin(!!cfg.auto_upload_after_relogin);
  }, []);

  const backendLabel = (b: Backend) => b === "sub2api" ? "sub2api" : b === "cpa" ? "CPA" : b === "grok2api" ? "Grok2API" : "未锁定";

  const loadBackend = useCallback(async () => {
    try {
      const data = await api<{ stored?: Backend; backend?: Backend }>(adminUrl("api", "remote-backend"));
      const b = (data.stored || data.backend || "") as Backend;
      setBackend(b);
      setBackendStatus({ text: "当前：" + backendLabel(b), kind: b ? "ok" : "warn", show: true });
    } catch {
      setBackendStatus({ text: "读取失败", kind: "bad", show: true });
    }
  }, []);

  const loadGrok2api = useCallback(async () => {
    const data = await api<{ config: Grok2apiCfg }>(adminUrl("api", "grok2api", "config"));
    applyGrok2api(data.config);
  }, [applyGrok2api]);

  const loadCpa = useCallback(async () => {
    const data = await api<{ config: CpaCfg }>(adminUrl("api", "cpa", "config"));
    applyCpa(data.config);
  }, [applyCpa]);

  const loadSub2api = useCallback(async () => {
    const data = await api<{ config: Sub2apiCfg }>(adminUrl("api", "sub2api", "config"));
    applySub2api(data.config);
  }, [applySub2api]);

  useEffect(() => {
    loadGrok2api().catch(() => {});
    loadCpa().catch(() => {});
    loadSub2api().catch(() => {});
    loadBackend().catch(() => {});
  }, [loadGrok2api, loadCpa, loadSub2api, loadBackend]);

  useEffect(() => {
    enforceExclusive("load");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grok2apiPayload = () => {
    let pwd = g.password || "";
    if (isMask(pwd)) pwd = "";
    return {
      base_url: (g.base_url || "").trim(),
      username: (g.username || "").trim(),
      password: pwd,
      upload_mode: g.upload_mode || "build_auth_files",
      limit: g.limit ?? 1000,
      upload_batch_size: g.upload_batch_size ?? 1,
      auto_upload_after_probe: gProbe,
      auto_upload_after_relogin: gRelogin,
    };
  };
  const cpaPayload = () => {
    let key = c.management_key || "";
    if (isMask(key)) key = "";
    return {
      base_url: (c.base_url || "").trim(),
      management_key: key,
      limit: c.limit ?? 1000,
      auto_upload_after_probe: cProbe,
      auto_upload_after_relogin: cRelogin,
      auto_delete_abnormal: cAutoDelete,
    };
  };
  const sub2apiPayload = () => {
    let key = s.api_key || "";
    if (isMask(key)) key = "";
    return {
      base_url: (s.base_url || "").trim(),
      api_key: key,
      limit: s.limit ?? 1000,
      sync_proxies: s.sync_proxies !== false,
      auto_upload_after_probe: sProbe,
      auto_upload_after_relogin: sRelogin,
    };
  };

  const run = (fn: () => Promise<void>, which: "g" | "c" | "s" | "b") => {
    fn().catch((err) => {
      const setter = which === "g" ? setGStatus : which === "c" ? setCStatus : which === "s" ? setSStatus : setBackendStatus;
      setter({ text: "失败", kind: "bad", show: true });
      if (which === "g") setGLog((err as { payload?: unknown }).payload || (err as Error).message);
      if (which === "c") setCLog((err as { payload?: unknown }).payload || (err as Error).message);
      if (which === "s") setSLog((err as { payload?: unknown }).payload || (err as Error).message);
      toast((err as Error).message);
    });
  };

  const saveBackend = async () => {
    setBackendStatus({ text: "保存中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "remote-backend"), { method: "PUT", body: JSON.stringify({ backend }) });
    if (data.grok2api) applyGrok2api(data.grok2api);
    if (data.cpa) applyCpa(data.cpa);
    if (data.sub2api) applySub2api(data.sub2api);
    const b = (data.backend || "") as Backend;
    setBackend(b);
    setBackendStatus({ text: "当前：" + backendLabel(b), kind: b ? "ok" : "warn", show: true });
    toast(data.message || "远端对接：" + backendLabel(b));
    await loadGrok2api().catch(() => {});
    await loadCpa().catch(() => {});
    await loadSub2api().catch(() => {});
  };

  const saveGrok2api = async () => {
    enforceExclusive("grok2api");
    setGStatus({ text: "保存中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "grok2api", "config"), { method: "PUT", body: JSON.stringify(grok2apiPayload()) });
    applyGrok2api(data.config);
    if (data.backend) setBackend(data.backend);
    setGStatus({ text: "已保存", kind: "ok", show: true });
    setGLog(data);
    toast(data.message || "Grok2API 配置已保存");
    await loadCpa().catch(() => {});
    await loadBackend().catch(() => {});
  };

  const testGrok2api = async () => {
    setGStatus({ text: "测试中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "grok2api", "test-login"), { method: "POST", body: JSON.stringify(grok2apiPayload()) });
    setGStatus({ text: data.ok ? "登录通过" : "登录失败", kind: data.ok ? "ok" : "bad", show: true });
    setGLog(data);
    toast(data.ok ? "Grok2API 测试通过" : data.error || data.message || "Grok2API 测试失败");
  };

  const saveCpa = async () => {
    enforceExclusive("cpa");
    setCStatus({ text: "保存中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "cpa", "config"), { method: "PUT", body: JSON.stringify(cpaPayload()) });
    applyCpa(data.config);
    if (data.backend) setBackend(data.backend);
    setCStatus({ text: "已保存", kind: "ok", show: true });
    setCLog(data);
    toast(data.message || "CPA 配置已保存");
    await loadGrok2api().catch(() => {});
    await loadBackend().catch(() => {});
  };

  const testCpa = async () => {
    setCStatus({ text: "测试中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "cpa", "test"), { method: "POST", body: JSON.stringify(cpaPayload()) });
    setCStatus({ text: data.ok ? "测试通过" : "测试失败", kind: data.ok ? "ok" : "bad", show: true });
    setCLog(data);
    toast(data.ok ? "CPA auth-files 可用" + (data.total != null ? " · total " + data.total : "") + (data.xai_total != null ? " · xai " + data.xai_total : "") : data.error || data.message || "CPA 测试失败");
  };

  const saveSub2api = async () => {
    enforceExclusive("sub2api");
    setSStatus({ text: "保存中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "sub2api", "config"), { method: "PUT", body: JSON.stringify(sub2apiPayload()) });
    applySub2api(data.config);
    if (data.backend) setBackend(data.backend);
    setSStatus({ text: "已保存", kind: "ok", show: true });
    setSLog(data);
    toast(data.message || "sub2api 配置已保存");
    await loadGrok2api().catch(() => {});
    await loadCpa().catch(() => {});
    await loadBackend().catch(() => {});
  };

  const testSub2api = async () => {
    setSStatus({ text: "测试中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "sub2api", "test"), { method: "POST", body: JSON.stringify(sub2apiPayload()) });
    setSStatus({ text: data.ok ? "测试通过" : "测试失败", kind: data.ok ? "ok" : "bad", show: true });
    setSLog(data);
    toast(data.ok ? "sub2api 可用" + (data.grok_total != null ? " · grok " + data.grok_total : "") : data.error || data.message || "sub2api 测试失败");
  };

  return (
    <>
      <div className="card-block">
        <div className="section-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
          <div>
            <h3 className="section-title" style={{ fontSize: 14, margin: 0 }}>远端对接（互斥）</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>Grok2API / CPA / sub2api 三选一。自动导入 / 拉取远端状态都只走当前锁定的一边；另一边即使勾选也不会执行。</p>
          </div>
          <div className="actions">
            <button className="btn" type="button" onClick={() => run(saveBackend, "b")}>锁定</button>
          </div>
        </div>
        <div className="form-grid">
          <div className="span-2">
            <label htmlFor="remote_backend">当前远端</label>
            <select id="remote_backend" value={backend} onChange={(e) => setBackend(e.target.value as Backend)}>
              <option value="">自动推断（看哪边开了自动导入）</option>
              <option value="grok2api">Grok2API</option>
              <option value="cpa">CPA（auth-files）</option>
              <option value="sub2api">sub2api</option>
            </select>
          </div>
        </div>
        {backendStatus.show && <Badge kind={backendStatus.kind}>{backendStatus.text}</Badge>}
      </div>

      <div className="card-block" style={{ marginTop: 12 }}>
        <div className="section-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
          <div>
            <h3 className="section-title" style={{ fontSize: 14, margin: 0 }}>Grok2API</h3>
          </div>
          <div className="header-checks">
            <label className="header-check">
              <input type="checkbox" checked={gProbe} onChange={(e) => { setGProbe(e.target.checked); enforceExclusive("grok2api", { gp: e.target.checked }); }} />
              注册测活通过后自动导入
            </label>
            <label className="header-check" title="重登批次结束后，仅同步测活通过的账号">
              <input type="checkbox" checked={gRelogin} onChange={(e) => { setGRelogin(e.target.checked); enforceExclusive("grok2api", { gr: e.target.checked }); }} />
              重登测活通过后自动导入
            </label>
          </div>
          <div className="actions">
            <button className="btn" type="button" onClick={() => run(saveGrok2api, "g")}>保存</button>
            <button className="btn" type="button" onClick={() => run(testGrok2api, "g")}>测试</button>
          </div>
        </div>
        <div className="form-grid">
          <div className="span-2">
            <label htmlFor="grok2api_base_url">地址</label>
            <input id="grok2api_base_url" placeholder="http://127.0.0.1:36214" value={g.base_url || ""} onChange={(e) => setG({ ...g, base_url: e.target.value })} />
          </div>
          <div>
            <label htmlFor="grok2api_username">账号</label>
            <input id="grok2api_username" autoComplete="username" value={g.username || ""} onChange={(e) => setG({ ...g, username: e.target.value })} />
          </div>
          <div>
            <label htmlFor="grok2api_password">密码</label>
            <input id="grok2api_password" type="password" autoComplete="current-password" value={g.password || ""} onChange={(e) => setG({ ...g, password: e.target.value })} />
          </div>
          <div>
            <label htmlFor="grok2api_upload_mode">导入/导出格式</label>
            <select id="grok2api_upload_mode" value={g.upload_mode || "build_auth_files"} onChange={(e) => setG({ ...g, upload_mode: e.target.value })}>
              <option value="build_auth_files">auth 文件（Grok Build）</option>
              <option value="web_sso">网页 SSO</option>
            </select>
          </div>
          <div>
            <label htmlFor="grok2api_limit">上限</label>
            <input id="grok2api_limit" type="number" min={1} max={5000} value={g.limit ?? 1000} onChange={(e) => setG({ ...g, limit: Number(e.target.value) })} />
          </div>
          <div>
            <label htmlFor="grok2api_upload_batch_size" title="已废弃">每批上传数量（已废弃）</label>
            <input id="grok2api_upload_batch_size" type="number" min={1} max={100} value={g.upload_batch_size ?? 1} disabled />
          </div>
        </div>
        {gStatus.show && <Badge kind={gStatus.kind}>{gStatus.text}</Badge>}
        {gLog != null && <Terminal content={renderLog("grok2api-log", gLog)} />}
      </div>

      <div className="card-block" style={{ marginTop: 12 }}>
        <div className="section-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
          <div>
            <h3 className="section-title" style={{ fontSize: 14, margin: 0 }}>CPA</h3>
          </div>
          <div className="header-checks">
            <label className="header-check">
              <input type="checkbox" checked={cProbe} onChange={(e) => { setCProbe(e.target.checked); enforceExclusive("cpa", { cp: e.target.checked }); }} />
              注册测活通过后自动导入
            </label>
            <label className="header-check" title="重登批次结束后，仅同步测活通过的账号；按批次上传">
              <input type="checkbox" checked={cRelogin} onChange={(e) => { setCRelogin(e.target.checked); enforceExclusive("cpa", { cr: e.target.checked }); }} />
              重登测活通过后自动导入
            </label>
            <label className="header-check" title="调度每轮先拉取 CPA 异常状态，再自动删除异常账号（远端 auth + 本地记录，带备份）">
              <input type="checkbox" checked={cAutoDelete} onChange={(e) => setCAutoDelete(e.target.checked)} />
              自动删除异常账号（需重登 / 额度用尽 / 权限拒绝）
            </label>
          </div>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>开启后调度每轮会先拉取 CPA 异常状态，再自动删除异常账号（远端 + 本地，带备份）。额度用尽类账号 24h 后会自行恢复，请谨慎开启。默认关闭。</p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => run(saveCpa, "c")}>保存</button>
            <button className="btn" type="button" onClick={() => run(testCpa, "c")}>测试</button>
          </div>
        </div>
        <div className="form-grid">
          <div className="span-2">
            <label htmlFor="cpa_base_url">地址</label>
            <input id="cpa_base_url" placeholder="https://cpa.snote.cc.cd 或 management.html 完整链接" value={c.base_url || ""} onChange={(e) => setC({ ...c, base_url: e.target.value })} />
          </div>
          <div className="span-2">
            <label htmlFor="cpa_management_key">管理密钥</label>
            <input id="cpa_management_key" type="password" autoComplete="off" value={c.management_key || ""} onChange={(e) => setC({ ...c, management_key: e.target.value })} />
          </div>
          <div>
            <label htmlFor="cpa_limit">上限</label>
            <input id="cpa_limit" type="number" min={1} max={5000} value={c.limit ?? 1000} onChange={(e) => setC({ ...c, limit: Number(e.target.value) })} />
          </div>
        </div>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>状态来自 CPA 原生 <code>/v0/management/auth-files</code>；可直接粘贴 management.html 链接，保存时会自动取域名。</p>
        {cStatus.show && <Badge kind={cStatus.kind}>{cStatus.text}</Badge>}
        {cLog != null && <Terminal content={renderLog("cpa-log", cLog)} />}
      </div>

      <div className="card-block" style={{ marginTop: 12 }}>
        <div className="section-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
          <div>
            <h3 className="section-title" style={{ fontSize: 14, margin: 0 }}>sub2api</h3>
          </div>
          <div className="header-checks">
            <label className="header-check">
              <input type="checkbox" checked={sProbe} onChange={(e) => { setSProbe(e.target.checked); enforceExclusive("sub2api", { sp: e.target.checked }); }} />
              注册测活通过后自动导入
            </label>
            <label className="header-check" title="重登批次结束后，仅同步测活通过的账号">
              <input type="checkbox" checked={sRelogin} onChange={(e) => { setSRelogin(e.target.checked); enforceExclusive("sub2api", { sr: e.target.checked }); }} />
              重登测活通过后自动导入
            </label>
            <label className="header-check" title="上传时把本地账号的代理同步到 sub2api 并逐账号关联">
              <input type="checkbox" checked={s.sync_proxies !== false} onChange={(e) => setS({ ...s, sync_proxies: e.target.checked })} />
              同步账号代理
            </label>
          </div>
          <div className="actions">
            <button className="btn" type="button" onClick={() => run(saveSub2api, "s")}>保存</button>
            <button className="btn" type="button" onClick={() => run(testSub2api, "s")}>测试</button>
          </div>
        </div>
        <div className="form-grid">
          <div className="span-2">
            <label htmlFor="sub2api_base_url">地址</label>
            <input id="sub2api_base_url" placeholder="https://sub2api.example 或 admin 完整链接" value={s.base_url || ""} onChange={(e) => setS({ ...s, base_url: e.target.value })} />
          </div>
          <div className="span-2">
            <label htmlFor="sub2api_api_key">管理员 API Key</label>
            <input id="sub2api_api_key" type="password" autoComplete="off" value={s.api_key || ""} onChange={(e) => setS({ ...s, api_key: e.target.value })} />
          </div>
          <div>
            <label htmlFor="sub2api_limit">上限</label>
            <input id="sub2api_limit" type="number" min={1} max={5000} value={s.limit ?? 1000} onChange={(e) => setS({ ...s, limit: Number(e.target.value) })} />
          </div>
        </div>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>通过 sub2api 原生 <code>/admin/grok/sso-to-oauth</code> 导入：只上传本地 SSO，转换与探活由 sub2api 完成。需先在 sub2api 后台开启管理员 API Key。</p>
        {sStatus.show && <Badge kind={sStatus.kind}>{sStatus.text}</Badge>}
        {sLog != null && <Terminal content={renderLog("sub2api-log", sLog)} />}
      </div>
    </>
  );
}
