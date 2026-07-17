import type { ReactNode } from "react";

export function Spinner(): ReactNode {
  return <div className="spinner" role="status" aria-label="جارٍ التحميل" />;
}

export function CenteredState({
  emoji,
  title,
  detail,
  children,
}: {
  emoji?: string;
  title: string;
  detail?: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="center">
      {emoji !== undefined ? <div className="emoji-lg">{emoji}</div> : null}
      <div className="card-title">{title}</div>
      {detail !== undefined ? <div className="muted">{detail}</div> : null}
      {children}
    </div>
  );
}

export function TopBar({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }): ReactNode {
  return (
    <header className="topbar">
      {onBack !== undefined ? (
        <button type="button" className="back-btn" onClick={onBack} aria-label="رجوع">
          ‹ رجوع
        </button>
      ) : null}
      <h1>{title}</h1>
      {right}
    </header>
  );
}

export function QtyControl({
  qty,
  onDec,
  onInc,
  disabled,
}: {
  qty: number;
  onDec: () => void;
  onInc: () => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <div className="qty">
      <button type="button" onClick={onDec} disabled={qty <= 0} aria-label="إنقاص">
        −
      </button>
      <span className="count">{qty}</span>
      <button type="button" onClick={onInc} disabled={disabled === true} aria-label="زيادة">
        +
      </button>
    </div>
  );
}
