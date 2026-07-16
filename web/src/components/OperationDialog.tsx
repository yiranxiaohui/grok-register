import { useOperation } from "@/context/OperationContext";

export function OperationDialog() {
  const { state, stop, toggleMinimize, close } = useOperation();
  const cls =
    "operation-dialog" + (state.open ? " open" : "") + (state.minimized ? " minimized" : "");
  return (
    <aside id="operation-dialog" className={cls} aria-live="polite">
      <div className="operation-head">
        <p id="operation-title" className="operation-title">
          {state.title}
        </p>
        <div className="operation-actions">
          {state.stoppable && (
            <button className="btn danger" type="button" onClick={stop}>
              停止
            </button>
          )}
          <button className="btn ghost" type="button" onClick={toggleMinimize}>
            {state.minimized ? "展开" : "最小化"}
          </button>
          <button className="btn ghost" type="button" onClick={close}>
            关闭
          </button>
        </div>
      </div>
      <pre id="operation-log" className="terminal">
        {state.log}
      </pre>
    </aside>
  );
}
