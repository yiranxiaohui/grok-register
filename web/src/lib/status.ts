// Status label maps and Chinese-text normalization ported verbatim from the
// original accounts.html so log lines and badges read identically.

const TERMINAL = new Set([
  "imported", "error", "failed", "stopped", "cancelled", "done", "partial", "success", "completed",
]);
const SUCCESS = new Set(["imported", "done", "success", "completed"]);
const FAILURE = new Set(["error", "failed"]);

export type StatusKind = "ok" | "warn" | "bad" | "";

export interface NormalizedStatus {
  label: string;
  kind: StatusKind;
  terminal: boolean;
}

export function translateStatus(status: string): string {
  const map: Record<string, string> = {
    idle: "待机",
    running: "运行中",
    registering: "注册中",
    waiting_solver: "等待过盾",
    solving_turnstile: "正在过盾",
    probing: "测活中",
    active: "可用",
    registered: "已注册",
    ok: "可用",
    failed: "失败",
    relogin: "需重登",
    relogged: "已重登",
    candidate: "候选",
    queued: "已入队",
    done: "完成",
    missing: "缺失",
    untested: "未测",
    disabled: "已停用",
    probe_failed: "测活失败",
    credentials_only: "仅密码",
    sso_pending: "待授权",
    waitingreset: "限流等待",
    not_imported: "未导入",
    not_synced: "未同步",
    normal: "正常",
    wait: "限流等待",
    reauthrequired: "需重登",
    reauth_required: "需重登",
  };
  return map[status] || status || "-";
}

export function normalizeStatus(status: string | undefined | null): NormalizedStatus {
  const s = String(status || "idle").toLowerCase();
  const terminal = TERMINAL.has(s);
  if (SUCCESS.has(s)) return { label: "完成", kind: "ok", terminal: true };
  if (s === "partial") return { label: "部分完成", kind: "warn", terminal: true };
  if (s === "cancelled" || s === "stopped") return { label: "已停止", kind: "bad", terminal: true };
  if (FAILURE.has(s)) return { label: "失败", kind: "bad", terminal: true };
  return { label: translateStatus(s), kind: terminal ? "bad" : "warn", terminal };
}

export function readableCheckName(name: string): string {
  const map: Record<string, string> = {
    "本地过盾": "本地过盾服务",
    "邮箱域名": "邮箱域名",
    "邮箱 API Key": "邮箱密钥",
    "邮箱服务": "邮箱服务",
    "邮箱 Base URL": "邮箱服务地址",
    "x.ai 注册页": "x.ai 注册页",
    "YesCaptcha": "YesCaptcha",
  };
  return map[name] || name || "未知项目";
}

export function readableProxyStrategy(strategy: string | undefined): string {
  const map: Record<string, string> = { round_robin: "轮询", random: "随机", sticky: "固定首个" };
  return map[strategy || ""] || strategy || "-";
}

export function toChineseText(text: unknown): string {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  // Phrase-level translations only. Avoid bare-word replaces that mangle
  // "failed to verify..." mid-sentence.
  const out = s
    .replace(/imported via sso_to_auth_json \((\d+) account\(s\)\); probe ok=(\d+) fail=(\d+).*/i, "已导入 $1 个账号；测活成功 $2 个，失败 $3 个。")
    .replace(/register_lite skips model probe/ig, "注册流程未执行模型测活")
    .replace(/YesCaptcha Turnstile solve failed after fallbacks:/ig, "过盾失败：")
    .replace(/TurnstileTaskProxyless:/ig, "")
    .replace(/YesCaptcha getTaskResult error:/ig, "")
    .replace(/ERROR_CAPTCHA_UNSOLVABLE: Workers could not solve the Captcha/ig, "本次过盾失败，请重试或更换代理出口。")
    .replace(/failed to verify Cloudflare turnstile token\.?/ig, "Cloudflare 过盾 token 校验失败（代理出口与过盾 IP 不一致、token 过期或并发过高）")
    .replace(/CreateSession 未返回 SSO/g, "密码登录未取得 SSO")
    .replace(/CreateSession/g, "密码登录")
    .replace(/正在获取验证码/g, "正在过盾")
    .replace(/等待本地验证码服务/g, "等待本地过盾服务")
    .replace(/验证码已通过/g, "过盾通过")
    .replace(/获取验证码/g, "过盾")
    .replace(/certificate verify failed/ig, "证书校验失败")
    .replace(/Connection refused/ig, "服务未启动或端口不可访问")
    .replace(/registration batch not found/ig, "注册批次已失效（进程重启后内存进度会丢失，账号仍在库中；请重新开始）")
    .replace(/registration session not found/ig, "注册会话已失效（进程重启后内存进度会丢失，账号仍在库中；请重新开始）")
    .replace(/\bNot Found\b/ig, "未找到")
    .replace(/Method Not Allowed/ig, "接口方法不匹配");
  const whole: Record<string, string> = {
    started: "已启动",
    saved: "已保存",
    running: "运行中",
    error: "错误",
    failed: "失败",
    imported: "已导入",
    idle: "待机",
    stopping: "停止中",
    stopped: "已停止",
    completed: "已完成",
    success: "成功",
  };
  const key = out.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(whole, key)) return whole[key];
  return out;
}

export function isTaskRunningStatus(status: string | undefined, runningFlag?: boolean | number): boolean {
  if (runningFlag) return true;
  const s = String(status || "").toLowerCase();
  return ["running", "starting", "stopping", "registering", "probing", "waiting_solver", "solving_turnstile", "queued"].indexOf(s) >= 0;
}
