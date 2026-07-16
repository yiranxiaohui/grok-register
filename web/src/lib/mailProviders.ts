import type { MailProvider } from "./types";

export interface MailProviderMeta {
  base_url: boolean;
  api_key: boolean;
  domain: boolean;
  expiry_ms: boolean;
  base_url_label: string;
  base_url_placeholder: string;
  base_url_note: string;
  api_key_label: string;
  api_key_note: string;
  domain_label: string;
  domain_placeholder: string;
  domain_note: string;
}

export const MAIL_PROVIDERS: { value: MailProvider; label: string }[] = [
  { value: "moemail", label: "MoeMail" },
  { value: "yyds", label: "YYDS" },
  { value: "gptmail", label: "GPTMail" },
  { value: "cfmail", label: "Cloudflare Temp Email" },
  { value: "duckmail", label: "DuckMail" },
  { value: "anymail", label: "AnyMail" },
];

const META: Record<MailProvider, MailProviderMeta> = {
  moemail: {
    base_url: true,
    api_key: true,
    domain: true,
    expiry_ms: true,
    base_url_label: "邮箱服务地址",
    base_url_placeholder: "https://moemail.example.com",
    base_url_note: "MoeMail 实例地址，必填",
    api_key_label: "API Key / 管理员密码",
    api_key_note: "MoeMail 管理密钥",
    domain_label: "域名",
    domain_placeholder: "留空则自动获取",
    domain_note: "可填多个，逗号分隔；留空自动拉域名",
  },
  yyds: {
    base_url: false,
    api_key: true,
    domain: true,
    expiry_ms: false,
    base_url_label: "邮箱服务地址",
    base_url_placeholder: "https://maliapi.215.im",
    base_url_note: "YYDS 固定地址，无需填写",
    api_key_label: "API Key",
    api_key_note: "YYDS 的 API Key（必填）",
    domain_label: "域名",
    domain_placeholder: "留空则自动获取",
    domain_note: "可填多个，逗号分隔；留空自动获取可用域名",
  },
  gptmail: {
    base_url: false,
    api_key: true,
    domain: true,
    expiry_ms: false,
    base_url_label: "邮箱服务地址",
    base_url_placeholder: "https://mail.chatgpt.org.uk",
    base_url_note: "GPTMail 固定地址，无需填写",
    api_key_label: "API Key",
    api_key_note: "GPTMail API Key（必填，不填不会使用公开测试密钥）",
    domain_label: "域名",
    domain_placeholder: "留空则自动获取",
    domain_note: "可填多个，逗号分隔；留空自动获取",
  },
  cfmail: {
    base_url: true,
    api_key: true,
    domain: true,
    expiry_ms: true,
    base_url_label: "Worker / 服务地址",
    base_url_placeholder: "例如 https://temp-mail.your-domain.com",
    base_url_note: "Cloudflare Temp Email 部署地址，必填；灰色字仅为示例，不是已保存值",
    api_key_label: "管理密码 / API Key",
    api_key_note: "Cloudflare Temp Email 管理密码（x-admin-auth）",
    domain_label: "域名",
    domain_placeholder: "留空则自动获取；示例 mail.example.com",
    domain_note: "可填多个，逗号分隔；灰色字仅为示例，不是已保存值",
  },
  duckmail: {
    base_url: false,
    api_key: true,
    domain: true,
    expiry_ms: true,
    base_url_label: "邮箱服务地址",
    base_url_placeholder: "https://api.duckmail.sbs",
    base_url_note: "DuckMail 固定公开 API，无需填写",
    api_key_label: "API Key（可选）",
    api_key_note: "公开域名可不填；私有域名填 dk_ 开头的 Key（Bearer）",
    domain_label: "域名",
    domain_placeholder: "留空则自动获取公开域名",
    domain_note: "可填多个，逗号分隔；留空自动从 GET /domains 随机",
  },
  anymail: {
    base_url: true,
    api_key: true,
    domain: true,
    expiry_ms: true,
    base_url_label: "服务地址（部署 URL）",
    base_url_placeholder: "例如 https://your-anymail.example.com",
    base_url_note: "AnyMail 自建实例地址，必填",
    api_key_label: "API Key",
    api_key_note: "AnyMail 的 ak_ 开头 Key（需 emails:read + accounts:write，绑定 provider=domain）",
    domain_label: "域名",
    domain_placeholder: "留空则自动获取",
    domain_note: "可填多个，逗号分隔；留空自动从 GET /api/domains 拉取",
  },
};

export function mailProviderMeta(provider: string): MailProviderMeta {
  return META[(provider as MailProvider)] || META.moemail;
}

export function normalizeMailProvider(mail: string | undefined): MailProvider {
  const m = String(mail || "moemail").toLowerCase();
  return (["moemail", "yyds", "gptmail", "cfmail", "duckmail", "anymail"].indexOf(m) >= 0
    ? m
    : "moemail") as MailProvider;
}

export interface ProviderDraft {
  base_url: string;
  api_key: string;
  domain: string;
}

export function defaultDraft(provider: MailProvider): ProviderDraft {
  if (provider === "yyds") return { base_url: "https://maliapi.215.im", api_key: "", domain: "" };
  if (provider === "gptmail") return { base_url: "https://mail.chatgpt.org.uk", api_key: "", domain: "" };
  if (provider === "duckmail") return { base_url: "https://api.duckmail.sbs", api_key: "", domain: "" };
  return { base_url: "", api_key: "", domain: "" };
}
