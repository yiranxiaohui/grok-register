import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { GrokLogo } from "./GrokLogo";

export function LoginScreen() {
  const { setupRequired, setupAllowed, minPasswordLen, login } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const title = setupRequired ? "设置管理员密码" : "管理员登录";
  let desc: string;
  if (setupRequired && !setupAllowed) {
    desc = "首次设密仅允许服务器本机访问。请在本机打开，或设置 GROK_REGISTER_ADMIN_BOOTSTRAP_PASSWORD。";
  } else if (setupRequired) {
    desc = `首次使用，设置一个至少 ${minPasswordLen} 位的本机管理员密码。`;
  } else {
    desc = "输入管理员密码后进入控制台。";
  }
  const submitLabel = setupRequired ? "保存并进入" : "登录";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("请输入管理员密码");
      return;
    }
    if (setupRequired && !setupAllowed) {
      setError("当前网络不允许远程首次设密，请在服务器本机操作");
      return;
    }
    if (setupRequired && password.length < minPasswordLen) {
      setError(`管理员密码至少 ${minPasswordLen} 位`);
      return;
    }
    setError("");
    try {
      await login(password);
      setPassword("");
    } catch (err) {
      setError((err as Error).message || "登录失败");
    }
  }

  return (
    <div id="login-screen" className="login-screen" aria-label="管理员登录">
      <section className="login-card">
        <div className="login-mark" aria-hidden="true" title="Grok">
          <GrokLogo />
        </div>
        <h1 className="login-title">{title}</h1>
        <p className="login-desc">{desc}</p>
        <form className="login-form" onSubmit={onSubmit}>
          <div>
            <label htmlFor="login-password">管理员密码</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button className="btn primary" type="submit" disabled={setupRequired && !setupAllowed}>
            {submitLabel}
          </button>
          <p className="login-error" role="alert">
            {error}
          </p>
        </form>
      </section>
    </div>
  );
}
