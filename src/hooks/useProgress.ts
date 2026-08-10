// 进度防抖回写（docs/architecture.md §6.3）：翻页/滚动停止 300ms 后
// save_progress；回写失败静默重试一次，仍失败则放弃，不打断阅读。
// 换书/关闭（bookId 变化或卸载）时 flush 未落盘的进度。

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Progress } from "../lib/types";

export interface ReadingProgress {
  chapterIdx: number;
  charOffset: number;
  percent: number;
}

export const PROGRESS_DEBOUNCE_MS = 300;

async function persistOnce(bookId: number, p: ReadingProgress): Promise<boolean> {
  try {
    await api.saveProgress(bookId, p.chapterIdx, p.charOffset, p.percent);
    return true;
  } catch {
    return false;
  }
}

async function persist(bookId: number, p: ReadingProgress): Promise<void> {
  const ok = await persistOnce(bookId, p);
  if (!ok) await persistOnce(bookId, p); // 静默重试一次，仍失败不再打扰阅读
}

interface Pending {
  bookId: number;
  progress: ReadingProgress;
}

interface UseProgressResult {
  /** 最近一次上报的进度（ProgressBar 等展示用），可作「续读定位」数据源。 */
  current: ReadingProgress | null;
  /** 翻页/滚动停止时调用；内部 300ms 防抖后落库。 */
  report: (p: ReadingProgress) => void;
  /** 立即落库尚未写出的进度（卸载 / 换书时自动调用）。 */
  flush: () => void;
}

export function useProgress(
  bookId: number | null,
  initial: Progress | null,
): UseProgressResult {
  const [current, setCurrent] = useState<ReadingProgress | null>(() =>
    initial
      ? {
          chapterIdx: initial.chapterIdx,
          charOffset: initial.charOffset,
          percent: initial.percent,
        }
      : null,
  );

  // 当前书的 id 放 ref：report 由 ChapterView 回调触发，book 可能在
  // openBook 完成前就渲染，必须拿到最终生效的 bookId。
  const bookIdRef = useRef<number | null>(bookId);
  const pendingRef = useRef<Pending | null>(null);
  const timerRef = useRef<number | null>(null);

  const report = useCallback((p: ReadingProgress) => {
    setCurrent((prev) =>
      prev &&
      prev.chapterIdx === p.chapterIdx &&
      prev.charOffset === p.charOffset &&
      prev.percent === p.percent
        ? prev
        : p,
    );
    if (bookIdRef.current == null) return; // 书尚未打开：只更新内存态，不落库
    pendingRef.current = { bookId: bookIdRef.current, progress: p };
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void persist(pending.bookId, pending.progress);
    }, PROGRESS_DEBOUNCE_MS);
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) void persist(pending.bookId, pending.progress);
  }, []);

  // 换书 / 关闭（bookId → null）：先把旧书的 pending 落地再切。
  // 卸载（返回书库视图走 ReaderView 置 null）也经此路 flush。
  useEffect(() => {
    if (bookIdRef.current !== bookId) {
      flush();
      bookIdRef.current = bookId;
    }
  }, [bookId, flush]);

  // 组件真正卸载（App 切换视图）时兜底 flush。
  useEffect(() => flush, [flush]);

  return { current, report, flush };
}