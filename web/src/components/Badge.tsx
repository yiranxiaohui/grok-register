import type { StatusKind } from "@/lib/status";

export function Badge({
  children,
  kind,
  className,
  title,
  style,
}: {
  children: React.ReactNode;
  kind?: StatusKind;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
}) {
  const cls = "badge" + (kind ? " " + kind : "") + (className ? " " + className : "");
  return (
    <span className={cls} title={title} style={style}>
      {children}
    </span>
  );
}
