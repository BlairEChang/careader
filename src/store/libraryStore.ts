// 书架/书库状态（docs/architecture.md §6.1）：列表、导入（批次语义）、移除、
// 进度角标映射（§6.3：list_progress 一次拉取全部书的 percent）。
// M6：搜索/排序（loaded 后前端过滤，无新后端命令）+ 导入失败恢复
// （lastFailed 记最近一次导入的失败清单，由书架摘要条渲染并可重试）。

import { create } from "zustand";
import { api, describeError, isAndroid, toast } from "../lib/api";
import type { Book, FailedImport } from "../lib/types";

export type SortMode = "recent" | "lastOpened" | "title";

export const SORT_LABELS: Record<SortMode, string> = {
  recent: "最近导入",
  lastOpened: "最近打开",
  title: "标题 A-Z",
};

export interface LibraryState {
  books: Book[];
  /** bookId → 阅读进度 percent（0~1），书架角标用；无记录的书不在其中。 */
  progressPercent: Record<number, number>;
  loading: boolean;
  importing: boolean;
  /** 搜索词（标题/作者，忽略大小写的中文包含匹配）。 */
  searchQuery: string;
  sortMode: SortMode;
  /** 最近一次导入的失败清单（{path, reason}）；为空不显示摘要条。 */
  lastFailed: FailedImport[];
  load: () => Promise<void>;
  loadProgress: () => Promise<void>;
  importBooks: (paths: string[]) => Promise<void>;
  removeBook: (id: number) => Promise<void>;
  setSearchQuery: (q: string) => void;
  setSortMode: (m: SortMode) => void;
  /** 对 lastFailed 里的 path 重新走 importBooks（成功/部分成功由 importBooks 更新 lastFailed）。 */
  retryFailed: () => Promise<void>;
  clearFailed: () => void;
}

let loadPromise: Promise<void> | null = null;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  books: [],
  progressPercent: {},
  loading: false,
  importing: false,
  searchQuery: "",
  sortMode: "recent",
  lastFailed: [],

  load: async () => {
    if (loadPromise) return loadPromise;
    set({ loading: true });
    loadPromise = (async () => {
      try {
        const [books, progress] = await Promise.all([api.listBooks(), api.listProgress()]);
        set({
          books,
          progressPercent: Object.fromEntries(progress.map((p) => [p.bookId, p.percent])),
        });
      } catch (e) {
        toast(describeError(e), "error");
      } finally {
        set({ loading: false });
      }
    })();
    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  },

  loadProgress: async () => {
    try {
      const progress = await api.listProgress();
      set({ progressPercent: Object.fromEntries(progress.map((p) => [p.bookId, p.percent])) });
    } catch (e) {
      toast(describeError(e), "error");
    }
  },

  importBooks: async (paths) => {
    if (paths.length === 0) return;
    set({ importing: true });
    try {
      const result = isAndroid() ? await api.importBooksFromUris(paths) : await api.importBooks(paths);
      set({ books: [...result.succeeded, ...get().books] });
      if (result.succeeded.length > 0) {
        toast(`已导入 ${result.succeeded.length} 本书`, "success");
      }
      // 失败不再逐条 toast：写入 lastFailed 由书架摘要条渲染（M6）。
      // 全部成功（含重试成功）时清空摘要。
      set({ lastFailed: result.failed });
    } catch (e) {
      toast(describeError(e), "error");
    } finally {
      set({ importing: false });
    }
  },

  removeBook: async (id) => {
    try {
      await api.removeBook(id);
      const progressPercent = { ...get().progressPercent };
      delete progressPercent[id];
      set({ books: get().books.filter((b) => b.id !== id), progressPercent });
      toast("已从书架移除", "success");
    } catch (e) {
      toast(describeError(e), "error");
    }
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
  setSortMode: (m) => set({ sortMode: m }),

  retryFailed: async () => {
    const paths = get().lastFailed.map((f) => f.path);
    if (paths.length === 0) return;
    await get().importBooks(paths);
  },

  clearFailed: () => set({ lastFailed: [] }),
}));

/** 搜索匹配：标题/作者，忽略大小写（中文直接按子串包含匹配）。 */
export function matchesQuery(book: Book, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (book.title.toLowerCase().includes(q)) return true;
  return book.authors.some((a) => a.toLowerCase().includes(q));
}

/** 排序：recent=入库时间倒序（默认）、lastOpened=最近打开倒序（未打开垫底）、
 *  title=标题 A-Z（中文按 zh locale）；同序用入库时间倒序稳定收尾。 */
export function sortBooks(books: Book[], mode: SortMode): Book[] {
  const arr = [...books];
  switch (mode) {
    case "lastOpened":
      arr.sort(
        (a, b) =>
          (b.lastOpenedAt ?? -Infinity) - (a.lastOpenedAt ?? -Infinity) ||
          b.addedAt - a.addedAt,
      );
      break;
    case "title":
      arr.sort((a, b) => a.title.localeCompare(b.title, "zh") || b.addedAt - a.addedAt);
      break;
    default:
      arr.sort((a, b) => b.addedAt - a.addedAt || b.id - a.id);
  }
  return arr;
}

/** 取路径最后一段文件名（摘要条展示用）。 */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}