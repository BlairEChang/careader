// 阅读器状态（docs/architecture.md §6.2）：当前书 + open_book 结果（模型 +
// 续读进度）+ 当前章节索引。App.tsx 只用 book 判断视图，close 恢复书库视图。

import { create } from "zustand";
import { api, describeError, toast } from "../lib/api";
import type { Book, OpenBook } from "../lib/types";

export interface ReaderState {
  book: Book | null;
  open: OpenBook | null;
  loading: boolean;
  /** 当前章节索引（重排管线导航用），打开书时以续读进度初始化。 */
  currentChapterIdx: number;
  openBook: (book: Book) => Promise<void>;
  close: () => void;
  jumpToChapter: (idx: number) => void;
}

function clampChapter(idx: number, chapterCount: number): number {
  if (chapterCount <= 0) return 0;
  return Math.min(Math.max(idx, 0), chapterCount - 1);
}

export const useReaderStore = create<ReaderState>((set) => ({
  book: null,
  open: null,
  loading: false,
  currentChapterIdx: 0,

  openBook: async (book) => {
    set({ loading: true });
    try {
      const open = await api.openBook(book.id);
      const chapterCount = open.model.chapters.length;
      const resumeIdx = open.progress ? open.progress.chapterIdx : 0;
      set({
        book,
        open,
        loading: false,
        currentChapterIdx: clampChapter(resumeIdx, chapterCount),
      });
    } catch (e) {
      set({ loading: false });
      toast(describeError(e), "error");
    }
  },

  close: () =>
    set({ book: null, open: null, loading: false, currentChapterIdx: 0 }),

  jumpToChapter: (idx) =>
    set((s) => ({ currentChapterIdx: clampChapter(idx, s.open?.model.chapters.length ?? 0) })),
}));