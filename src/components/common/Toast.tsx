// 统一 Toast：监听 api.toast 派发的全局事件，自动消失。

import { useEffect, useState } from "react";
import type { ToastKind } from "../../lib/api";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const TOAST_EVENT = "careader:toast";
const TOAST_DURATION_MS = 3500;

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let nextId = 1;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string; kind?: ToastKind }>).detail;
      const id = nextId++;
      setItems((prev) => [...prev, { id, message: detail.message, kind: detail.kind ?? "info" }]);
      window.setTimeout(
        () => setItems((prev) => prev.filter((t) => t.id !== id)),
        TOAST_DURATION_MS,
      );
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="toast-host">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}