// invoke 封装 + 错误翻译（docs/architecture.md §7）。
// Rust 侧错误统一为 { code, message }，code 白名单在此映射为中文文案。

import { invoke } from "@tauri-apps/api/core";
import type {
  Annotation,
  Book,
  ImportResult,
  OpenBook,
  Progress,
  TocEntry,
} from "./types";

export const ERROR_LABELS: Record<string, string> = {
  parse_failed: "解析失败",
  unsupported_format: "不支持的格式",
  file_not_found: "文件不存在",
  not_found: "记录不存在",
  internal: "内部错误",
  db: "数据库错误",
  io: "文件读写错误",
};

/** 把 IPC 拒绝的对象翻译为可读消息。 */
export function describeError(e: unknown): string {
  const err = (e ?? {}) as { code?: string; message?: string };
  if (err.code && ERROR_LABELS[err.code]) {
    return err.message ? `${ERROR_LABELS[err.code]}：${err.message}` : ERROR_LABELS[err.code];
  }
  return err.message ?? String(e);
}

export type ToastKind = "info" | "success" | "error";

/** 全局 Toast 事件（ToastHost 组件监听）。 */
export function toast(message: string, kind: ToastKind = "info"): void {
  window.dispatchEvent(
    new CustomEvent("careader:toast", { detail: { message, kind } }),
  );
}

/** 运行平台是否为 Android（Tauri Android WebView 的 UA 含 Android）。 */
export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("android");
}

export const api = {
  importBooks: (paths: string[]) => invoke<ImportResult>("import_books", { paths }),
  /** Android：dialog.open() 返回 content:// URI，走 ContentResolver 导入命令。 */
  importBooksFromUris: (uris: string[]) =>
    invoke<ImportResult>("import_books_from_uris", { uris }),
  listBooks: () => invoke<Book[]>("list_books"),
  removeBook: (id: number) => invoke<void>("remove_book", { id }),

  openBook: (id: number) => invoke<OpenBook>("open_book", { id }),
  getToc: (id: number) => invoke<TocEntry[]>("get_toc", { id }),
  saveProgress: (bookId: number, chapterIdx: number, charOffset: number, percent: number) =>
    invoke<void>("save_progress", { bookId, chapterIdx, charOffset, percent }),
  listProgress: () => invoke<Progress[]>("list_progress"),

  /** 新建标注；`page` 为 PDF 页码（1 基），重排书不传（缺省 None）。 */
  createAnnotation: (
    bookId: number,
    kind: string,
    chapterIdx: number,
    start: number,
    end: number,
    text: string | null,
    color: string,
    page?: number | null,
  ) =>
    invoke<Annotation>("create_annotation", {
      bookId,
      kind,
      chapterIdx,
      start,
      end,
      text,
      color,
      page,
    }),
  listAnnotations: (bookId: number) => invoke<Annotation[]>("list_annotations", { bookId }),
  /** 部分更新：仅发送给出的字段（至少一项）。 */
  updateAnnotation: (id: number, patch: { noteBody?: string; color?: string }) => {
    const args: Record<string, unknown> = { id };
    if (patch.noteBody !== undefined) args.noteBody = patch.noteBody;
    if (patch.color !== undefined) args.color = patch.color;
    return invoke<Annotation>("update_annotation", args);
  },
  deleteAnnotation: (id: number) => invoke<void>("delete_annotation", { id }),

  getSettings: () => invoke<Record<string, unknown>>("get_settings"),
  setSettings: (key: string, value: unknown) => invoke<void>("set_settings", { key, value }),

  /** 读取书库内文件字节（asset protocol 加载失败时的回退，见 lib/assets.ts）。 */
  readAssetBytes: (path: string) => invoke<number[]>("read_asset_bytes", { path }),
};