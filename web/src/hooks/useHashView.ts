import { useEffect, useState } from "react";

export type ViewName = "register" | "accounts" | "settings";

function parseHash(): ViewName {
  let v = (location.hash || "#register").slice(1);
  if (v === "grok2api" || v === "import") v = "settings";
  if (v !== "register" && v !== "accounts" && v !== "settings") v = "register";
  return v as ViewName;
}

export function useHashView(): [ViewName, (v: ViewName) => void] {
  const [view, setView] = useState<ViewName>(parseHash);

  useEffect(() => {
    const onHash = () => setView(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (v: ViewName) => {
    if (location.hash !== "#" + v) {
      history.replaceState(null, "", "#" + v);
    }
    setView(v);
  };

  return [view, navigate];
}
