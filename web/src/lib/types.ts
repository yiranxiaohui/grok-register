// Shared types. The backend returns loosely-shaped JSON; these interfaces cover
// the fields the UI reads and stay permissive with index signatures.

export type MailProvider = "moemail" | "yyds" | "gptmail" | "cfmail" | "duckmail" | "anymail";

export interface SessionInfo {
  authenticated: boolean;
  setup_required?: boolean;
  setup_allowed?: boolean;
  min_password_len?: number;
}

export interface RegistrationConfig {
  mail_provider?: string;
  base_url?: string;
  api_key?: string;
  domain?: string;
  moemail_base_url?: string;
  moemail_api_key?: string;
  moemail_domain?: string;
  yyds_api_key?: string;
  yyds_domain?: string;
  gptmail_api_key?: string;
  gptmail_domain?: string;
  cfmail_base_url?: string;
  cfmail_api_key?: string;
  cfmail_domain?: string;
  duckmail_api_key?: string;
  duckmail_domain?: string;
  anymail_base_url?: string;
  anymail_api_key?: string;
  anymail_domain?: string;
  expiry_ms?: number;
  count?: number;
  concurrency?: number;
  global_inflight?: number;
  captcha_concurrency?: number;
  power_mode?: boolean;
  stagger_ms?: number;
  probe_delay_sec?: number;
  proxy?: string;
  proxy_username?: string;
  proxy_password?: string;
  proxy_strategy?: string;
  [key: string]: unknown;
}

export interface ProbeInfo {
  ok?: boolean | number;
  error?: string;
  status_code?: number;
  latency_ms?: number;
}

export interface RemoteInfo {
  reason?: string;
  message?: string;
  error?: string;
  action?: string;
  inspection_action?: string;
  remote_action?: string;
  classification?: string;
  http_status?: number;
  status_code?: number;
  code?: number;
  ok?: boolean;
  [key: string]: unknown;
}

export interface Account {
  email?: string;
  id?: string;
  status?: string;
  auth_key?: string;
  batch_id?: string;
  session_id?: string;
  created_at?: string | number;
  last_probe?: ProbeInfo;
  remote?: RemoteInfo | null;
  _remote?: RemoteInfo | null;
  auth_data?: {
    grok2api?: boolean;
    grok2api_name?: string;
    cpa?: boolean;
    cpa_name?: string;
  };
  [key: string]: unknown;
}

export interface AccountStats {
  local_total?: number;
  remote_relogin?: number;
  remote_failed?: number;
  remote_only_failures?: number;
  remote_total?: number;
  remote_synced?: boolean;
  remote_synced_at?: string | null;
  remote_backend?: string | null;
  matched_local?: number;
  [key: string]: unknown;
}

export interface AccountsResponse {
  accounts?: Account[];
  total?: number;
  page?: number;
  page_size?: number;
  total_pages?: number;
  stats?: AccountStats;
}

export type LogData = unknown;
