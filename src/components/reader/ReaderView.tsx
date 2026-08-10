// 阅读器主容器（docs/architecture.md §6.2）：顶栏（返回/书名/TOC/设置）+
// 正文（ChapterView 分页 or 滚动，PDF 走 PdfViewer 整页管线 §6.4）+
// 底部进度条。契约：未选择书返回 null（App.tsx 借此切回书架视图）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { Spinner } from "../common/Spinner";
import { useReaderStore } from "../../store/readerStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useBookContent } from "../../hooks/useBookContent";
import { useProgress, type ReadingProgress } from "../../hooks/useProgress";
import { useAnnotations } from "../../hooks/useAnnotations";
import { ChapterView } from "./reflowable/ChapterView";
import { PdfViewer } from "./fixed/PdfViewer";
import { AnnotationLayer } from "./AnnotationLayer";
import { TableOfContents } from "./TableOfContents";
import { ProgressBar } from "./ProgressBar";
import { ReaderSettings } from "./ReaderSettings";
import { NotesPanel } from "../notes/NotesPanel";
import { api, describeError, toast } from "../../lib/api";
import { percentToChapterOffset, type ChapterOffset } from "./reflowable/paginate";
import type { Annotation } from "../../lib/types";
import "../../styles/reader.css";

export function ReaderView() {
  const book = useReaderStore((s) => s.book);
  const open = useReaderStore((s) => s.open);
  const loading = useReaderStore((s) => s.loading);
  const currentChapterIdx = useReaderStore((s) => s.currentChapterIdx);
  const close = useReaderStore((s) => s.close);
  const jumpToChapter = useReaderStore((s) => s.jumpToChapter);

  const settings = useSettingsStore((s) => s.settings);
  const chapters = useBookContent(open);

  const { current, report } = useProgress(book?.id ?? null, open?.progress ?? null);

  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  /** ProgressBar 点击跳转的目标章/偏移；TOC 跳转或换书时清空。 */
  const seekTargetRef = useRef<ChapterOffset | null>(null);
  /** 当前正文容器（ChapterView 上报；AnnotationLayer 的选区/渲染作用域）。 */
  const [contentContainer, setContentContainer] = useState<HTMLElement | null>(null);

  const annotations = useAnnotations(book?.id ?? null);

  /** PDF 书签会话列表：null 表示尚未发生本会话变更，直接读 annotations.items。 */
  const [pdfBookmarks, setPdfBookmarks] = useState<Annotation[] | null>(null);
  /** PDF 总页数（PdfViewer 加载完成后上报；ProgressBar 跳页换算用）。 */
  const [pdfPageCount, setPdfPageCount] = useState(0);
  /** PDF 跳页请求（ProgressBar 点击 / NotesPanel 跳转），1 基。 */
  const [pdfSeek, setPdfSeek] = useState<number | null>(null);

  // PDF 会话标注列表：本会话有变更后以会话列表为准，否则直读 annotations.items。
  const pdfAnnotations = pdfBookmarks ?? annotations.items;

  const setContentMount = useCallback((el: HTMLElement | null) => {
    setContentContainer((prev) => (prev === el ? prev : el));
  }, []);

  // 换书（book.id 变化）时丢弃旧的跳转目标。
  const prevBookIdRef = useRef<number | null>(book?.id ?? null);
  if (prevBookIdRef.current !== (book?.id ?? null)) {
    seekTargetRef.current = null;
    setPdfBookmarks(null);
    setPdfPageCount(0);
    setPdfSeek(null);
    prevBookIdRef.current = book?.id ?? null;
  }

  // Android 返回键：面板开着先关面板，否则退出阅读器回书架。
  // 用 @tauri-apps/api 的 onBackButtonPress（Tauri ≥2.9 原生事件）：注册监听后
  // AppPlugin 收到 onBackPressed 只转发事件（不默认 goBack/退出），桌面注册不触发。
  const backHandlerRef = useRef<() => void>(() => {});
  backHandlerRef.current = () => {
    if (notesOpen) setNotesOpen(false);
    else if (tocOpen) setTocOpen(false);
    else if (settingsOpen) setSettingsOpen(false);
    else close();
  };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void onBackButtonPress(() => backHandlerRef.current())
      .then((l) => {
        if (active) unlisten = () => void l.unregister();
        else void l.unregister();
      })
      .catch(() => {
        // 非 Android / 旧版 Tauri 无此事件：静默降级。
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const handleProgress = useCallback(
    (p: ReadingProgress) => {
      report(p);
    },
    [report],
  );

  const handleChapterEnd = useCallback(
    (dir: 1 | -1) => {
      const count = open?.model.chapters.length ?? 0;
      if (count === 0) return;
      const idx = Math.min(Math.max(currentChapterIdx + dir, 0), count - 1);
      jumpToChapter(idx);
    },
    [currentChapterIdx, open, jumpToChapter],
  );

  const handleSeek = useCallback(
    (percent: number) => {
      if (!chapters || chapters.length === 0) return;
      const loc = percentToChapterOffset(chapters, percent);
      seekTargetRef.current = loc;
      jumpToChapter(loc.chapterIdx);
    },
    [chapters, jumpToChapter],
  );

  const handleTocJump = useCallback(
    (idx: number) => {
      seekTargetRef.current = null; // 目录跳转不带偏移意图，从章首开始
      jumpToChapter(idx);
    },
    [jumpToChapter],
  );

  // PDF：ProgressBar 点击 → 按比例换算页码后请求 PdfViewer 跳页。
  const handlePdfSeek = useCallback(
    (percent: number) => {
      if (pdfPageCount <= 0) return;
      const page = Math.min(Math.max(Math.round(percent * pdfPageCount), 1), pdfPageCount);
      setPdfSeek(page);
    },
    [pdfPageCount],
  );

  const handlePdfPageCount = useCallback((n: number) => {
    setPdfPageCount((prev) => (prev === n ? prev : n));
  }, []);

  // PdfViewer 只追踪书签子集；回写时与非书签项合并为完整会话列表
  // （PDF 暂无高亮/笔记 UI，此处防御性保留 annotations 中的其他项）。
  const handlePdfBookmarksChange = useCallback(
    (bookmarkList: Annotation[]) => {
      setPdfBookmarks((prev) => {
        const base = prev ?? annotations.items;
        const nonBookmarks = base.filter((a) => a.kind !== "bookmark");
        return [...bookmarkList, ...nonBookmarks];
      });
    },
    [annotations.items],
  );

  // 笔记/书签列表跳转：定位到标注起始偏移（复用 seekTarget 续读定位机制）。
  const handleAnnotationJump = useCallback(
    (a: Annotation) => {
      // PDF 标注（page 定位）：跳页并按比例回写进度（chapter_idx = 页码）。
      if (a.page != null) {
        setPdfSeek(a.page);
        report({ chapterIdx: a.page, charOffset: 0, percent: a.page / Math.max(pdfPageCount, 1) });
        setNotesOpen(false);
        return;
      }
      seekTargetRef.current = { chapterIdx: a.chapterIdx, charOffset: a.start };
      jumpToChapter(a.chapterIdx);
      setNotesOpen(false);
    },
    [jumpToChapter, pdfPageCount, report],
  );

  // PDF 笔记抽屉删除：走会话列表（useAnnotations 无法表达 page 字段），
  // 乐观过滤 + 失败回滚。
  const handlePdfAnnotationDelete = useCallback(
    (id: number) => {
      const snapshot = pdfAnnotations;
      setPdfBookmarks(snapshot.filter((a) => a.id !== id));
      api.deleteAnnotation(id).catch((e) => {
        setPdfBookmarks(snapshot);
        toast(describeError(e), "error");
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pdfAnnotations],
  );

  // 续读/跳转定位：优先 ProgressBar 的跳转目标，其次 open_book 返回的续读进度。
  const initialOffset = useMemo(() => {
    const target = seekTargetRef.current;
    if (target && target.chapterIdx === currentChapterIdx) return target.charOffset;
    if (open?.progress && open.progress.chapterIdx === currentChapterIdx) {
      return open.progress.charOffset;
    }
    return null;
  }, [open, currentChapterIdx]);

  if (!book) return null;

  const isPdf = open?.model.format === "pdf" && !loading;
  const chapter =
    chapters && currentChapterIdx < chapters.length ? chapters[currentChapterIdx] : null;
  const percent = current?.percent ?? open?.progress?.percent ?? 0;
  const currentHasBookmark = annotations.hasBookmark(currentChapterIdx);
  const chapterAnnotations = annotations.chapterAnnotations(currentChapterIdx);

  return (
    <div className="reader-app">
      <header className="reader-topbar">
        <button className="btn btn-ghost reader-topbar-back" onClick={close}>
          ← 书库
        </button>
        <div className="reader-topbar-title">
          <h1>{book.title}</h1>
          <p>{book.authors.join("、") || "佚名"}</p>
        </div>
        <div className="reader-topbar-actions">
          {!loading && !isPdf && chapter && (
            <button
              className="btn reader-topbar-btn"
              disabled={currentHasBookmark}
              title={currentHasBookmark ? "本章已有书签" : "给本章加书签"}
              onClick={() => void annotations.createBookmark(currentChapterIdx)}
            >
              书签
            </button>
          )}
          {!loading && !isPdf && (
            <button className="btn reader-topbar-btn" onClick={() => setTocOpen(true)}>
              目录
            </button>
          )}
          {!loading && (isPdf || chapter) && (
            <button className="btn reader-topbar-btn" onClick={() => setNotesOpen(true)}>
              笔记
            </button>
          )}
          <button className="btn reader-topbar-btn" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>
      </header>

      <main className="reader-main">
        {loading ? (
          <div className="reader-loading">
            <Spinner />
          </div>
        ) : isPdf ? (
          <PdfViewer
            key={book.id}
            book={book}
            initialPage={open?.progress?.chapterIdx ?? 1}
            bookmarks={pdfAnnotations.filter((a) => a.kind === "bookmark")}
            onProgress={handleProgress}
            onBookmarksChange={handlePdfBookmarksChange}
            onPageCount={handlePdfPageCount}
            seekPage={pdfSeek}
          />
        ) : !chapter ? (
          <div className="reader-placeholder">
            <p>本书暂无章节正文。</p>
          </div>
        ) : (
          <ChapterView
            key={`${chapter.id}:${initialOffset ?? "auto"}`}
            chapters={chapters ?? []}
            chapter={chapter}
            chapterIdx={currentChapterIdx}
            mode={settings.paginationMode}
            fontSize={settings.fontSize}
            lineHeight={settings.lineHeight}
            fontFamily={settings.fontFamily}
            initialOffset={initialOffset}
            onProgress={handleProgress}
            onChapterEnd={handleChapterEnd}
            onContentMount={setContentMount}
          />
        )}
      </main>

      {!loading && isPdf && (
        <ProgressBar percent={percent} onSeek={handlePdfSeek} />
      )}

      {!loading && !isPdf && chapter && (
        <ProgressBar percent={percent} onSeek={handleSeek} />
      )}

      {!loading && !isPdf && chapter && (
        <AnnotationLayer
          container={contentContainer}
          chapter={chapter}
          chapterIdx={currentChapterIdx}
          annotations={chapterAnnotations}
          onCreate={annotations.create}
          onUpdate={annotations.update}
          onDelete={annotations.remove}
        />
      )}

      <TableOfContents
        open={tocOpen}
        title={book.title}
        chapters={chapters ?? []}
        currentIdx={currentChapterIdx}
        onClose={() => setTocOpen(false)}
        onJump={handleTocJump}
      />
      <NotesPanel
        open={notesOpen}
        chapters={chapters ?? []}
        items={isPdf ? pdfAnnotations : annotations.items}
        onClose={() => setNotesOpen(false)}
        onJump={handleAnnotationJump}
        onDelete={isPdf ? handlePdfAnnotationDelete : (id) => void annotations.remove(id)}
      />
      <ReaderSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}