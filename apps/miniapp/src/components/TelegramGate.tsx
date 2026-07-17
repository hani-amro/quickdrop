import type { ReactNode } from "react";
import { CenteredState } from "./ui";

// initData فارغ = التطبيق مفتوح خارج تيليغرام. لا نُلفّق initData (§10.3) —
// نعرض شاشة إرشاد واضحة بدل الانكسار.
export function TelegramGate(): ReactNode {
  return (
    <div className="app">
      <CenteredState
        emoji="📱"
        title="افتح التطبيق من داخل تيليغرام"
        detail="هذه واجهة QuickDrop المصغّرة وتعمل فقط عند فتحها من بوت المتجر داخل تطبيق تيليغرام."
      />
    </div>
  );
}
