// 底部进度条（docs/architecture.md §6.3）：展示整书 percent（0~1），
// 点击任意位置按比例跳转（整书 percent → 章/章内偏移换算在父组件做）。

import { useRef } from "react";
import type { MouseEvent } from "react";

interface ProgressBarProps {
  /** 整书进度 0~1。 */
  percent: number;
  /** 点击跳转，回传目标 percent（0~1）。 */
  onSeek: (percent: number) => void;
}

export function ProgressBar({ percent, onSeek }: ProgressBarProps) {
  const barRef = useRef<HTMLElement>(null);
  const pct = Math.min(1, Math.max(0, percent));

  const handleClick = (e: MouseEvent<HTMLElement>) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(p);
  };

  return (
    <footer
      className="reader-progress"
      ref={barRef}
      onClick={handleClick}
      title="点击跳转"
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="reader-progress-fill" style={{ width: `${pct * 100}%` }} />
      <span className="reader-progress-label">{Math.round(pct * 100)}%</span>
    </footer>
  );
}