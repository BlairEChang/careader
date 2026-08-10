// 书架视图（docs/architecture.md §6.1）：书格网格 + 导入入口 + 空态。
// M6：搜索（标题/作者，忽略大小写中文包含匹配）+ 排序（recent/lastOpened/title，
// 后端 loaded 后前端过滤）+ 导入失败摘要条（可关闭、可重试）。

import { useEffect, useMemo } from "react";
import {
  fileName,
  matchesQuery,
  sortBooks,
  SORT_LABELS,
  useLibraryStore,
  type SortMode,
} from "../../store/libraryStore";
import { Spinner } from "../common/Spinner";
import { BookCard } from "./BookCard";
import { ImportDialog } from "./ImportDialog";

export function LibraryView() {
  const books = useLibraryStore((s) => s.books);
  const loading = useLibraryStore((s) => s.loading);
  const importing = useLibraryStore((s) => s.importing);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const sortMode = useLibraryStore((s) => s.sortMode);
  const lastFailed = useLibraryStore((s) => s.lastFailed);
  const load = useLibraryStore((s) => s.load);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const setSortMode = useLibraryStore((s) => s.setSortMode);
  const retryFailed = useLibraryStore((s) => s.retryFailed);
  const clearFailed = useLibraryStore((s) => s.clearFailed);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(
    () => sortBooks(books.filter((b) => matchesQuery(b, searchQuery)), sortMode),
    [books, searchQuery, sortMode],
  );

  return (
    <div className="library">
      <header className="library-header">
        <h1>书库</h1>
        <ImportDialog />
      </header>

      {lastFailed.length > 0 && (
        <div className="library-failed" role="alert">
          <div className="library-failed-head">
            <p className="library-failed-title">有 {lastFailed.length} 本书导入失败</p>
            <button
              className="btn btn-ghost library-failed-dismiss"
              onClick={clearFailed}
              aria-label="关闭失败提示"
            >
              ×
            </button>
          </div>
          <ul className="library-failed-list">
            {lastFailed.map((f) => (
              <li key={f.path}>
                {fileName(f.path)}：{f.reason}
              </li>
            ))}
          </ul>
          <div className="library-failed-actions">
            <button
              className="btn btn-primary"
              onClick={() => void retryFailed()}
              disabled={importing}
            >
              {importing ? "重试中…" : "重试"}
            </button>
          </div>
        </div>
      )}

      {books.length > 0 && (
        <div className="library-controls">
          <input
            className="library-search"
            type="search"
            placeholder="搜索标题 / 作者…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <select
            className="library-sort"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            aria-label="排序方式"
          >
            {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
              <option key={m} value={m}>
                {SORT_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && books.length === 0 ? (
        <div className="library-loading">
          <Spinner />
        </div>
      ) : books.length === 0 ? (
        <div className="library-empty">
          <p>书架还是空的，点击右上角「导入书籍」开始阅读。</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="library-empty">
          <p>没有匹配「{searchQuery}」的书。</p>
        </div>
      ) : (
        <div className="book-grid">
          {visible.map((b) => (
            <BookCard key={b.id} book={b} />
          ))}
        </div>
      )}
    </div>
  );
}