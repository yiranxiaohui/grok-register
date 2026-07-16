import { createContext, useCallback, useContext, useRef, useState } from "react";

interface OperationState {
  open: boolean;
  minimized: boolean;
  title: string;
  log: string;
  stoppable: boolean;
}

interface OperationContextValue {
  state: OperationState;
  show: (title: string, message?: string, opts?: { stoppable?: boolean; onStop?: () => void }) => void;
  update: (message: string) => void;
  setStopVisible: (visible: boolean) => void;
  toggleMinimize: () => void;
  close: () => void;
  stop: () => void;
}

const OperationContext = createContext<OperationContextValue | null>(null);

export function OperationProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OperationState>({
    open: false,
    minimized: false,
    title: "任务日志",
    log: "等待任务",
    stoppable: false,
  });
  const stopHandler = useRef<(() => void) | null>(null);
  // Callbacks the dialog's close button should run (stop polling timers, etc).
  const closeHandlers = useRef<Array<() => void>>([]);

  const show = useCallback(
    (title: string, message?: string, opts?: { stoppable?: boolean; onStop?: () => void }) => {
      stopHandler.current = opts?.onStop || null;
      setState({
        open: true,
        minimized: false,
        title,
        log: message || "任务已启动",
        stoppable: !!opts?.stoppable,
      });
    },
    [],
  );

  const update = useCallback((message: string) => {
    setState((s) => ({ ...s, log: message || "" }));
  }, []);

  const setStopVisible = useCallback((visible: boolean) => {
    setState((s) => ({ ...s, stoppable: visible }));
  }, []);

  const toggleMinimize = useCallback(() => {
    setState((s) => ({ ...s, minimized: !s.minimized }));
  }, []);

  const close = useCallback(() => {
    setState((s) => ({ ...s, open: false, stoppable: false }));
    closeHandlers.current.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
  }, []);

  const stop = useCallback(() => {
    if (stopHandler.current) stopHandler.current();
  }, []);

  return (
    <OperationContext.Provider value={{ state, show, update, setStopVisible, toggleMinimize, close, stop }}>
      {children}
    </OperationContext.Provider>
  );
}

export function useOperation(): OperationContextValue {
  const ctx = useContext(OperationContext);
  if (!ctx) throw new Error("useOperation must be used within OperationProvider");
  return ctx;
}
