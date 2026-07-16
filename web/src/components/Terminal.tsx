import type { JSX } from "react";

// A <pre class="terminal"> that shows either plain text or pre-rendered log JSX.
export function Terminal({
  className,
  content,
  style,
}: {
  className?: string;
  content: string | JSX.Element;
  style?: React.CSSProperties;
}) {
  const cls = "terminal" + (className ? " " + className : "");
  return (
    <pre className={cls} style={style}>
      {content}
    </pre>
  );
}
