import { useState } from "react";
import { adminUrl } from "@/lib/adminBase";
import { api } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useAuth } from "@/context/AuthContext";

export function AdminPasswordCard() {
  const { toast } = useToast();
  const { minPasswordLen } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const change = async () => {
    if (!current) return toast("请输入当前密码");
    if (!next || next.length < minPasswordLen) return toast("新密码至少 " + minPasswordLen + " 位");
    if (next !== confirm) return toast("两次新密码不一致");
    const data = await api<{ message?: string }>(adminUrl("api", "auth", "change-password"), {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    setCurrent("");
    setNext("");
    setConfirm("");
    toast(data.message || "管理员密码已更新");
  };

  return (
    <div className="card-block" style={{ marginTop: 12 }}>
      <h3 className="section-title" style={{ fontSize: 14, margin: "0 0 10px" }}>管理员密码</h3>
      <div className="form-grid">
        <div>
          <label htmlFor="admin_password_current">当前密码</label>
          <input id="admin_password_current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label htmlFor="admin_password_new">新密码</label>
          <input id="admin_password_new" type="password" autoComplete="new-password" placeholder="至少 10 位" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div>
          <label htmlFor="admin_password_confirm">确认新密码</label>
          <input id="admin_password_confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button className="btn primary" type="button" onClick={() => { void change().catch((err) => toast((err as Error).message)); }}>更新密码</button>
        </div>
      </div>
    </div>
  );
}
