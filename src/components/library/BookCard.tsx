// 单本书卡片：封面（asset 协议 URL，失败回退字节流 blob）/ 标题 / 作者 / 格式角标 / 进度角标。

import { useEffect, useRef, useState } from "react";
import { assetBlobUrl, assetUrl } from "../../lib/assets";
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

/** 封面：优先 asset 协议 URL；onError（Android 部分真机失效，docs/android-port.md
 *  §4.2）回退 IPC 字节流 blob URL，卸载时 revoke。 */
function CoverImage({ book }: { book: Book }) {
  const [src, setSrc] = useState(() => assetUrl(book.coverPath ?? ""));
  const revokeRef = useRef<(() => void) | null>(null);

  const fallbackToBlob = async () => {
    if (revokeRef.current || !book.coverPath) return;
    try {
      const r = await assetBlobUrl(book.coverPath);
      revokeRef.current = r.revoke;
      setSrc(r.url);
    } catch {
      // 字节流也失败：标记已尝试，避免 onError 反复触发。
      revokeRef.current = () => {};
    }
  };

  useEffect(() => () => revokeRef.current?.(), []);

  return <img src={src} alt={`${book.title} 封面`} onError={() => void fallbackToBlob()} />;
}

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
          <CoverImage book={book} />
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