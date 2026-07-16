import { mailProviderMeta, MAIL_PROVIDERS } from "@/lib/mailProviders";
import type { MailProvider } from "@/lib/types";

// Controlled mail-provider block: dropdown + base_url / api_key / domain /
// expiry_ms, shown/hidden and relabeled per provider (original syncMailProviderFields).
export function MailProviderFields({
  provider,
  baseUrl,
  apiKey,
  domain,
  expiryMs,
  onProviderChange,
  onBaseUrlChange,
  onApiKeyChange,
  onDomainChange,
  onExpiryChange,
}: {
  provider: MailProvider;
  baseUrl: string;
  apiKey: string;
  domain: string;
  expiryMs: number;
  onProviderChange: (p: MailProvider) => void;
  onBaseUrlChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onDomainChange: (v: string) => void;
  onExpiryChange: (v: number) => void;
}) {
  const meta = mailProviderMeta(provider);
  return (
    <>
      <div>
        <label htmlFor="mail_provider">邮箱服务</label>
        <select
          id="mail_provider"
          value={provider}
          onChange={(e) => onProviderChange(e.target.value as MailProvider)}
        >
          {MAIL_PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {meta.base_url && (
        <div className="mail-field">
          <label htmlFor="base_url">{meta.base_url_label}</label>
          <input
            id="base_url"
            placeholder={meta.base_url_placeholder}
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
          />
          {meta.base_url_note && <div className="field-note">{meta.base_url_note}</div>}
        </div>
      )}

      {meta.api_key && (
        <div className="mail-field">
          <label htmlFor="api_key">{meta.api_key_label}</label>
          <input
            id="api_key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          {meta.api_key_note && <div className="field-note">{meta.api_key_note}</div>}
        </div>
      )}

      {meta.domain && (
        <div className="mail-field">
          <label htmlFor="domain">{meta.domain_label}</label>
          <input
            id="domain"
            placeholder={meta.domain_placeholder}
            spellCheck={false}
            value={domain}
            onChange={(e) => onDomainChange(e.target.value)}
          />
          {meta.domain_note && <div className="field-note">{meta.domain_note}</div>}
        </div>
      )}

      {meta.expiry_ms && (
        <div className="mail-field">
          <label htmlFor="expiry_ms">邮箱有效期</label>
          <select id="expiry_ms" value={expiryMs} onChange={(e) => onExpiryChange(Number(e.target.value))}>
            <option value={3600000}>1 小时</option>
            <option value={86400000}>1 天</option>
            <option value={259200000}>3 天</option>
            <option value={0}>永久</option>
          </select>
        </div>
      )}
    </>
  );
}
