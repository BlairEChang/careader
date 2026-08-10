// 多选导入（docs/architecture.md §6.1）：dialog 插件选择 → import_books 批次处理。

import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "../../lib/api";
import { useLibraryStore } from "../../store/libraryStore";

const BOOK_FILTERS = [
  {
    name: "电子书",
    extensions: ["txt", "md", "markdown", "epub", "mobi", "azw", "azw3", "pdf"],
  },
];

export function ImportDialog() {
  const importing = useLibraryStore((s) => s.importing);
  const importBooks = useLibraryStore((s) => s.importBooks);

  async function onPick() {
    try {
      const paths = await open({ multiple: true, directory: false, filters: BOOK_FILTERS });
      if (paths) {
        await importBooks(Array.isArray(paths) ? paths : [paths]);
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