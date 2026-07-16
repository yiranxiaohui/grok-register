import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/context/ToastContext";
import { OperationProvider } from "@/context/OperationContext";
import { LoginScreen } from "@/components/LoginScreen";
import { Sidebar } from "@/components/Sidebar";
import { OperationDialog } from "@/components/OperationDialog";
import { useHashView } from "@/hooks/useHashView";
import { useTaskRestore } from "@/hooks/useTaskRestore";
import { RegisterView } from "@/pages/RegisterView";
import { AccountsView } from "@/pages/AccountsView";
import { SettingsView } from "@/pages/SettingsView";

function Shell() {
  const [view, navigate] = useHashView();
  useTaskRestore();
  return (
    <div className="shell">
      <Sidebar view={view} onNavigate={navigate} />
      <main className="main">
        <div className="content">
          {view === "register" && <RegisterView />}
          {view === "accounts" && <AccountsView />}
          {view === "settings" && <SettingsView />}
        </div>
      </main>
    </div>
  );
}

function Gate() {
  const { phase } = useAuth();
  return (
    <>
      {phase !== "authed" && <LoginScreen />}
      {phase === "authed" && <Shell />}
      <OperationDialog />
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <OperationProvider>
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </OperationProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
