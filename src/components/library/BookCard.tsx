// 单本书卡片：封面（asset 协议 URL）/ 标题 / 作者 / 格式角标 / 进度角标。

import { assetUrl } from "../../lib/assets";
import type { Book } from "../../lib/types";
import { useLibraryStore } from "../../store/libraryStore";
import { useReaderStore } from "../../store/readerStore";

const FORMAT_LABEL: Record<string, string> = {
  epub: "EPUB",
  mobi: "MOBI",
  txt: "TXT",
  md: "MD",
  pdf: "PDF",
};

export function BookCard({ book }: { book: Book }) {
  const openBook = useReaderStore((s) => s.openBook);
  const removeBook = useLibraryStore((s) => s.removeBook);
  const progressPercent = useLibraryStore((s) => s.progressPercent);
  const percent = progressPercent[book.id] ?? 0;

  return (
    <article
      className="book-card"
      onClick={() => openBook(book)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") openBook(book);
      }}
    >
      <div className="book-cover">
        {book.coverPath ? (
          <img src={assetUrl(book.coverPath)} alt={`${book.title} 封面`} />
        ) : (
          <span className="book-cover-fallback">{FORMAT_LABEL[book.format] ?? book.format}</span>
        )}
        {percent > 0 && (
          <span className="book-progress-badge">{Math.round(percent * 100)}%</span>
        )}
      </div>
      <h3 className="book-title">{book.title}</h3>
      <p className="book-authors">{book.authors.join("、") || "佚名"}</p>
      <button
        className="btn btn-ghost book-remove"
        onClick={(e) => {
          e.stopPropagation();
          removeBook(book.id);
        }}
      >
        移除
      </button>
    </article>
  );
}