// 导入（docs/architecture.md §6.1）：
//   - 桌面：dialog.open() → import_books（本地路径）
//   - Android：android-fs 的 ACTION_OPEN_DOCUMENT 选择器（dialog 插件用 GET_CONTENT，
//     DownloadStorageProvider 会 Permission Denial）→ 返回带读权限的 content:// URI →
//     import_books_from_uris。

import { toast } from "../../lib/api";
import { useLibraryStore } from "../../store/libraryStore";

const BOOK_FILTERS = [
  { name: "电子书", extensions: ["txt", "md", "markdown", "epub", "mobi", "azw", "azw3", "pdf"] },
];
const BOOK_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "application/epub+zip",
  "application/pdf",
  "application/x-mobipocket-ebook",
  "application/octet-stream",
];

export function ImportDialog() {
  const importing = useLibraryStore((s) => s.importing);
  const importBooks = useLibraryStore((s) => s.importBooks);

  async function onPick() {
    try {
      if (importing) return;
      const { isAndroid } = await import("../../lib/api");
      const { open } = await import("@tauri-apps/plugin-dialog");
      if (isAndroid()) {
        const api = await import("../../lib/api");
        const picked = await api.api.androidShowOpenFilePicker(false, BOOK_MIME_TYPES);
        const uris = picked.map((p) => p.uri).filter(Boolean);
        if (uris.length > 0) await importBooks(uris);
      } else {
        const paths = await open({ multiple: true, directory: false, filters: BOOK_FILTERS });
        if (paths) {
          await importBooks(Array.isArray(paths) ? paths : [paths]);
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  return (
    <button className="btn btn-primary" onClick={onPick} disabled={importing}>
      {importing ? "导入中…" : "导入书籍"}
    </button>
  );
}