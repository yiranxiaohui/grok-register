import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { adminUrl } from "@/lib/adminBase";
import { detailMessage, setUnauthorizedHandler } from "@/lib/api";
import type { SessionInfo } from "@/lib/types";

type AuthPhase = "pending" | "login" | "authed";

interface AuthContextValue {
  phase: AuthPhase;
  setupRequired: boolean;
  setupAllowed: boolean;
  minPasswordLen: number;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>("pending");
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupAllowed, setSetupAllowed] = useState(true);
  const [minPasswordLen, setMinPasswordLen] = useState(10);

  const applyBodyClass = useCallback((next: AuthPhase) => {
    const b = document.body.classList;
    b.toggle("authenticated", next === "authed");
    b.toggle("login-required", next === "login");
    b.toggle("auth-pending", next === "pending");
  }, []);

  const setAuthUi = useCallback(
    (authed: boolean, needsSetup: boolean, opts?: { setupAllowed?: boolean; minPasswordLen?: number }) => {
      setSetupRequired(needsSetup);
      if (opts && typeof opts.setupAllowed === "boolean") setSetupAllowed(opts.setupAllowed);
      if (opts?.minPasswordLen) setMinPasswordLen(Math.max(6, opts.minPasswordLen));
      const next: AuthPhase = authed ? "authed" : "login";
      setPhase(next);
      applyBodyClass(next);
    },
    [applyBodyClass],
  );

  const checkSession = useCallback(async () => {
    const res = await fetch(adminUrl("api", "session"), { cache: "no-store", credentials: "same-origin" });
    const data: SessionInfo = await res.json();
    if (data.min_password_len) setMinPasswordLen(Math.max(6, data.min_password_len));
    if (data.authenticated) {
      setAuthUi(true, false, { setupAllowed: true, minPasswordLen: data.min_password_len || minPasswordLen });
    } else {
      setAuthUi(false, !!data.setup_required, {
        setupAllowed: data.setup_allowed !== false,
        minPasswordLen: data.min_password_len || minPasswordLen,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setAuthUi]);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthUi(false, false));
    checkSession().catch(() => setAuthUi(false, false));
    return () => setUnauthorizedHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (password: string) => {
      const res = await fetch(adminUrl("api", "auth", "login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(detailMessage(data));
      setAuthUi(true, false);
    },
    [setAuthUi],
  );

  const logout = useCallback(async () => {
    await fetch(adminUrl("api", "auth", "logout"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    setAuthUi(false, false);
  }, [setAuthUi]);

  return (
    <AuthContext.Provider value={{ phase, setupRequired, setupAllowed, minPasswordLen, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
