import { useTheme } from "@/context/ThemeContext";
import { useAuth } from "@/context/AuthContext";
import { GrokLogo } from "./GrokLogo";
import type { ViewName } from "@/hooks/useHashView";

const NAV: { view: ViewName; label: string }[] = [
  { view: "register", label: "注册" },
  { view: "accounts", label: "账号池" },
  { view: "settings", label: "设置" },
];

export function Sidebar({
  view,
  onNavigate,
}: {
  view: ViewName;
  onNavigate: (v: ViewName) => void;
}) {
  const { theme, toggle } = useTheme();
  const { logout } = useAuth();

  return (
    <aside className="sidebar" aria-label="后台导航">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true" title="Grok">
          <GrokLogo />
        </div>
        <div className="brand-copy">
          <p className="brand-title">Grok注册机</p>
        </div>
      </div>
      <nav className="nav">
        {NAV.map((item) => (
          <a
            key={item.view}
            href={"#" + item.view}
            className={view === item.view ? "active" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(item.view);
            }}
          >
            <span className="nav-dot" />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="theme-toggle"
          type="button"
          title={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}
          aria-label="切换浅色/深色模式"
          onClick={toggle}
        >
          <svg className="theme-icon-moon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M16.5 2.5A8.5 8.5 0 1 0 21.5 14.5 7 7 0 0 1 16.5 2.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
          <svg className="theme-icon-sun" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.7" />
            <path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.1 5.1l1.5 1.5M17.4 17.4l1.5 1.5M18.9 5.1l-1.5 1.5M6.6 17.4l-1.5 1.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <span>{theme === "light" ? "深色模式" : "浅色模式"}</span>
        </button>
        <button className="nav-action logout" type="button" onClick={() => void logout()}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M10 7V6.2C10 5.08 10 4.52 10.22 4.09C10.41 3.72 10.72 3.41 11.09 3.22C11.52 3 12.08 3 13.2 3H17.8C18.92 3 19.48 3 19.91 3.22C20.28 3.41 20.59 3.72 20.78 4.09C21 4.52 21 5.08 21 6.2V17.8C21 18.92 21 19.48 20.78 19.91C20.59 20.28 20.28 20.59 19.91 20.78C19.48 21 18.92 21 17.8 21H13.2C12.08 21 11.52 21 11.09 20.78C10.72 20.59 10.41 20.28 10.22 19.91C10 19.48 10 18.92 10 17.8V17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M14 12H4M4 12L6.5 9.5M4 12L6.5 14.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>退出登录</span>
        </button>
      </div>
    </aside>
  );
}
