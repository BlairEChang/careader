// 与 Rust 后端对齐的共享类型（docs/architecture.md §5）

export type Format = "epub" | "mobi" | "txt" | "md" | "pdf";

/** 翻页模式（docs/architecture.md §10 定稿项）。 */
export type PaginationMode = "paged" | "scroll";

export interface Book {
  id: number;
  title: string;
  authors: string[];
  format: Format;
  filePath: string;
  coverPath: string | null;
  addedAt: number;
  lastOpenedAt: number | null;
}

export interface FailedImport {
  path: string;
  reason: string;
}

export interface ImportResult {
  succeeded: Book[];
  failed: FailedImport[];
}

export type Element =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "image"; src: string };

export interface Resource {
  id: string;
  mime: string;
  path: string;
}

export interface Chapter {
  id: string;
  title: string;
  content: Element[];
  resources: Resource[];
}

export interface DocumentModel {
  format: Format;
  title: string;
  authors: string[];
  language: string | null;
  chapters: Chapter[];
  cover: string | null;
}

export interface Progress {
  bookId: number;
  chapterIdx: number;
  charOffset: number;
  percent: number;
  updatedAt: number;
}

export interface OpenBook {
  model: DocumentModel;
  progress: Progress | null;
}

export type AnnotationKind = "highlight" | "note" | "bookmark";

/** 高亮/笔记/书签（docs/architecture.md §5.2 annotations 表）。
 *  字段为 camelCase：Rust 侧 Annotation 以 #[serde(rename_all = "camelCase")]
 *  序列化，跨 IPC 键名一一对应。 */
export interface Annotation {
  id: number;
  bookId: number;
  kind: AnnotationKind;
  chapterIdx: number;
  /** 章内字符起（重排，UTF-16 码元索引，与 paginate 语义一致）。 */
  start: number;
  end: number;
  /** 高亮原文快照；书签为 null。 */
  text: string | null;
  /** 笔记正文；纯高亮为 null。 */
  noteBody: string | null;
  color: string;
  /** PDF 页码；重排书恒为 null（M5 使用）。 */
  page: number | null;
  createdAt: number;
}

export interface TocEntry {
  id: string;
  title: string;
}