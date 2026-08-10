// PDF 整页管线（docs/architecture.md §6.4）：pdf.js 渲染，后端模型无正文。
//
// 加载：asset protocol URL（assetUrl → convertFileSrc）交给 getDocument，加载/
// 失败均有中文状态。渲染：纵向滚动容器 + 绝对定位单页画布，只挂载可视区前后
// PRE_FETCH 页（窗口外页面卸载，其 effect 清理里 cancel 未完成 RenderTask）。
// 尺寸：加载时预取全部页面 scale=1 的宽高，窗口滚动只重渲染画布。
//
// 进度：页码变化后 300ms 防抖上报 onProgress({ chapterIdx: 页码, charOffset: 0,
// percent: 页码/pageCount })，卸载时兜底 flush 未上报进度（useProgress 再防抖落库）。
// 书签：直接调 api.createAnnotation/deleteAnnotation（kind=bookmark、
// chapter_idx=0、start=end=0、text=null、page=当前页），乐观更新 + 失败回滚
// 并 Toast；列表变更经 onBookmarksChange 回传父组件供 NotesPanel 展示。
// 大纲：getOutline() 扁平化（保留深度缩进）→ 下拉面板；dest 解析至少支持
// [页码, ...] 与 [Ref, 'XYZ'|...] 常见形式，具名目标经 getDestination 解析，
// 其余形式兜底忽略。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Spinner } from "../../common/Spinner";
import { api, describeError, toast } from "../../../lib/api";
import { assetUrl } from "../../../lib/assets";
import type { Annotation, Book } from "../../../lib/types";
import type { ReadingProgress } from "../../../hooks/useProgress";

GlobalWorkerOptions.workerSrc = workerUrl;

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const SCALE_STEP = 0.25;
/** 可视区外预取页数。 */
const PRE_FETCH = 1;
/** 进度上报防抖（docs/architecture.md §6.3 滚动停止后回写）。 */
const REPORT_DEBOUNCE_MS = 300;

export interface PdfViewerProps {
  book: Book;
  /** 续读起始页码（1 基；来自 open.progress.chapter_idx，见 §6.4）。 */
  initialPage: number;
  /** 该书已存书签（kind=bookmark、page 定位；父组件维护的会话列表）。 */
  bookmarks: Annotation[];
  /** 页码/进度变化上报（chapterIdx=页码、charOffset=0、percent=页码/总页数）。 */
  onProgress: (p: ReadingProgress) => void;
  /** 书签列表变更回传（新增/删除后父组件更新会话状态）。 */
  onBookmarksChange: (list: Annotation[]) => void;
  /** 文档总页数就绪回调（ReaderView 用于 ProgressBar 点击换算页码）。 */
  onPageCount: (count: number) => void;
  /** 跳页请求（ProgressBar 点击 / NotesPanel 跳转），1 基；null 表示无请求。 */
  seekPage: number | null;
}

interface PageDim {
  /** scale=1 时的 CSS 宽。 */
  w: number;
  /** scale=1 时的 CSS 高。 */
  h: number;
}

interface OutlineNode {
  title: string;
  dest: unknown;
  items?: OutlineNode[];
}

interface OutlineEntry {
  title: string;
  depth: number;
  dest: unknown;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready" };

/** pdf.js 异常 → 可读中文文案（error 状态展示用）。 */
function pdfErrorLabel(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as { message?: string })?.message ?? String(e);
  switch (name) {
    case "MissingPDFException":
      return "无法打开 PDF：文件不存在（可能已被移动或删除）。";
    case "InvalidPDFException":
      return "无法打开 PDF：文件格式无效或已损坏。";
    case "PasswordException":
      return "无法打开 PDF：文件已加密，暂不支持密码解锁。";
    case "UnexpectedResponseException":
      return "无法打开 PDF：文件读取失败，请确认文件可访问。";
    case "RenderingCancelledException":
      return "";
    default:
      break;
  }
  if (/fetch|network|protocol|asset|Unable to load/i.test(msg)) {
    return "无法打开 PDF：文件读取失败，请确认文件在书库目录中。";
  }
  return "无法打开 PDF：文件解析失败或文件已损坏。";
}

/** 大纲 dest → 1 基页码。支持 [页码, ...]、[Ref, 'XYZ'|...] 与具名目标；
 *  无法解析返回 null（调用方兜底提示）。 */
async function destToPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  if (dest == null) return null;
  if (typeof dest === "string") {
    const resolved = await doc.getDestination(dest);
    return resolved ? destToPage(doc, resolved) : null;
  }
  if (Array.isArray(dest)) return destToPage(doc, dest[0]);
  const ref = dest as { num?: unknown };
  if (typeof ref === "object" && typeof ref.num === "number" && Number.isInteger(ref.num) && ref.num > 0) {
    return ref.num;
  }
  return null;
}

/** 扁平化大纲树（保留深度供缩进）。 */
function flattenOutline(items: OutlineNode[], depth: number): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const item of items ?? []) {
    out.push({ title: item.title, depth, dest: item.dest });
    if (item.items && item.items.length > 0) {
      out.push(...flattenOutline(item.items, depth + 1));
    }
  }
  return out;
}

/** 单页画布：仅在窗口内挂载；effect 清理时取消未完成的渲染任务。 */
function PdfPageCanvas({
  doc,
  index,
  scale,
  left,
  width,
  height,
}: {
  doc: PDFDocumentProxy;
  /** 0 基页号。 */
  index: number;
  scale: number;
  /** 绝对定位横向偏移（页面居中）。 */
  left: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let alive = true;
    let task: RenderTask | null = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (!alive) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
      } catch (e) {
        // 取消后的渲染以 RenderingCancelledException 正常收尾；其余失败
        // 静默（该页留白，滚动离开再回来自会重试）。
        if (alive && (e as { name?: string })?.name !== "RenderingCancelledException") {
          console.warn(`pdf page ${index + 1} render failed`, e);
        }
      }
    };
    void render();
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [doc, index, scale]);

  return (
    <div className="pdf-page" style={{ left, width, height }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

export function PdfViewer({
  book,
  initialPage,
  bookmarks,
  onProgress,
  onBookmarksChange,
  onPageCount,
  seekPage,
}: PdfViewerProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState(1);
  /** 全部页面 unscaled 尺寸（加载时一次性测量）。 */
  const [dims, setDims] = useState<PageDim[] | null>(null);
  /** 当前挂载的页窗口（含预取），0 基闭区间。 */
  const [windowRange, setWindowRange] = useState<[number, number] | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 续读只定位一次（缩放重排等不重复触发）。 */
  const placedRef = useRef(false);
  /** 进度上报：滚动中追页号，300ms 静默后再上报。 */
  const reportTimerRef = useRef<number | null>(null);
  const pendingPageRef = useRef<number | null>(null);
  const lastReportedPageRef = useRef(0);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const loadedDocRef = useRef<PDFDocumentProxy | null>(null);
  /** 缩放前滚动位置（全局比例），布局重排后恢复。 */
  const anchorRatioRef = useRef<number | null>(null);
  const busyBookmarkRef = useRef(false);

  const pageCount = doc?.numPages ?? 0;

  // ---------- 文档加载 ----------
  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    setDoc(null);
    setDims(null);
    setOutline(null);
    setOutlineOpen(false);
    setScale(1);
    placedRef.current = false;
    lastReportedPageRef.current = 0;
    if (reportTimerRef.current !== null) window.clearTimeout(reportTimerRef.current);
    reportTimerRef.current = null;
    pendingPageRef.current = null;

    const url = assetUrl(book.filePath);
    // 首选流式 URL 加载（asset protocol 支持 Range/Content-Type，超大文件友好）；
    // 个别 WebView 对自定义 scheme 的 fetch 支持不完整时，回退为字节流加载
    // （getDocument({ data })），保证 dev/prod 各平台都能打开。
    let loadingTask: PDFDocumentLoadingTask = getDocument({
      url,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    const fetchable = (e: unknown) => {
      const name = (e as { name?: string })?.name ?? "";
      const msg = (e as { message?: string })?.message ?? String(e);
      return (
        name === "UnexpectedResponseException" ||
        name === "MissingPDFException" ||
        /fetch|network|protocol|asset|unable to load/i.test(msg)
      );
    };
    const load = async (): Promise<PDFDocumentProxy> => {
      try {
        return await loadingTask.promise;
      } catch (e) {
        if (!alive || !fetchable(e)) throw e;
        // 首次加载疑似网络层失败：整体销毁后用字节数据重试一次。
        void loadingTask.destroy();
        const resp = await fetch(url);
        if (!resp.ok) throw e;
        const task = getDocument({
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
          data: await resp.arrayBuffer(),
        });
        loadingTask = task;
        return task.promise;
      }
    };
    const destroyIfStale = () => {
      if (!alive) {
        void loadingTask.destroy();
        return true;
      }
      return false;
    };
    load()
      .then(async (pdf) => {
        if (destroyIfStale()) return;
        // 预取全部页面尺寸：getPage 仅解析页树，远快于渲染；绝对定位
        // 需要全部前置页高度，故一次性测量。
        const n = pdf.numPages;
        const ds = new Array<PageDim>(n);
        for (let i = 0; i < n; i++) {
          const v = await pdf.getPage(i + 1).then((p) => p.getViewport({ scale: 1 }));
          ds[i] = { w: v.width, h: v.height };
        }
        if (destroyIfStale()) return;
        if (n === 0) {
          setState({ phase: "error", message: "无法打开 PDF：文档不含任何页面。" });
          void loadingTask.destroy();
          return;
        }
        const items = (await pdf.getOutline().catch(() => null)) as OutlineNode[] | null;
        if (destroyIfStale()) return;
        const flat = items ? flattenOutline(items, 0) : null;
        loadedDocRef.current = pdf;
        setDoc(pdf);
        setDims(ds);
        setOutline(flat && flat.length > 0 ? flat : null);
        onPageCount(n);
        setState({ phase: "ready" });
      })
      .catch((e) => {
        if (!alive) return;
        const message = pdfErrorLabel(e);
        if (message) setState({ phase: "error", message });
        else setState({ phase: "ready" });
      });

    return () => {
      alive = false;
      if (loadingTask) void loadingTask.destroy();
      loadedDocRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, book.filePath]);

  // ---------- 布局：scaled 偏移 ----------
  const layout = useMemo(() => {
    if (!dims || dims.length === 0) return null;
    const offsets = new Array<number>(dims.length + 1);
    let acc = 0;
    offsets[0] = 0;
    for (let i = 0; i < dims.length; i++) {
      acc += dims[i].h * scale;
      offsets[i + 1] = acc;
    }
    return { offsets };
  }, [dims, scale]);

  const pages = useMemo(() => {
    if (!dims) return null;
    const maxW = Math.max(...dims.map((d) => d.w)) * scale;
    return dims.map((d, i) => ({
      index: i,
      width: d.w * scale,
      height: d.h * scale,
      left: (maxW - d.w * scale) / 2,
      top: layout ? (layout.offsets[i] ?? 0) : 0,
    }));
  }, [dims, scale, layout]);

  const totalHeight = layout ? layout.offsets[layout.offsets.length - 1] : 0;
  const sheetWidth = pages ? Math.max(...pages.map((p) => p.width)) : 0;

  // ---------- 滚动：窗口与当前页 ----------
  const findPage = useCallback(
    (top: number) => {
      const offsets = layout?.offsets;
      if (!offsets || offsets.length < 2) return 0;
      // 最大的 offsets[i] <= top 的下标，收敛到 [0, n-1]。
      let lo = 0;
      let hi = offsets.length - 2;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (offsets[mid] <= top) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [layout],
  );

  const updateWindow = useCallback(() => {
    const node = scrollRef.current;
    if (!node || !layout) return;
    const n = layout.offsets.length - 1;
    if (n <= 0) return;
    const start = findPage(node.scrollTop);
    const end = findPage(node.scrollTop + node.clientHeight - 1);
    const ws = Math.max(0, start - PRE_FETCH);
    const we = Math.min(n - 1, end + PRE_FETCH);
    setWindowRange((prev) => (prev && prev[0] === ws && prev[1] === we ? prev : [ws, we]));
    const page = start + 1;
    setCurrentPage((p) => (p === page ? p : page));
    pendingPageRef.current = page;
    if (reportTimerRef.current !== null) window.clearTimeout(reportTimerRef.current);
    reportTimerRef.current = window.setTimeout(() => {
      reportTimerRef.current = null;
      const pending = pendingPageRef.current;
      pendingPageRef.current = null;
      if (pending != null && pending !== lastReportedPageRef.current) {
        lastReportedPageRef.current = pending;
        onProgressRef.current({ chapterIdx: pending, charOffset: 0, percent: pending / pageCount });
      }
    }, REPORT_DEBOUNCE_MS);
  }, [layout, findPage, pageCount]);

  useEffect(() => {
    if (state.phase !== "ready") return;
    updateWindow();
    const node = scrollRef.current;
    if (!node) return;
    node.addEventListener("scroll", updateWindow, { passive: true });
    return () => node.removeEventListener("scroll", updateWindow);
  }, [state.phase, updateWindow]);

  // 容器尺寸变化（窗口缩放）后重算窗口。
  useEffect(() => {
    if (state.phase !== "ready") return;
    const node = scrollRef.current;
    if (!node) return;
    const ro = new ResizeObserver(() => updateWindow());
    ro.observe(node);
    return () => ro.disconnect();
  }, [state.phase, updateWindow]);

  // ---------- 跳页 / 续读定位 ----------
  const scrollToPage = useCallback(
    (page: number) => {
      const node = scrollRef.current;
      if (!node || !layout) return;
      const n = layout.offsets.length - 1;
      const idx = Math.min(Math.max(page - 1, 0), n - 1);
      // +1px：让滚动位置落进该页区间（页顶边界处 findPage 判定相邻页）。
      node.scrollTop = layout.offsets[idx] + 1;
    },
    [layout],
  );

  // 续读定位：文档与布局就绪后仅执行一次。
  useEffect(() => {
    if (state.phase !== "ready" || !layout || placedRef.current) return;
    placedRef.current = true;
    scrollToPage(initialPage);
    updateWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, layout]);

  // 外部跳页请求（ProgressBar 点击 / NotesPanel 跳转）。
  useEffect(() => {
    if (state.phase !== "ready" || seekPage == null || !layout) return;
    scrollToPage(seekPage);
    updateWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, seekPage, layout]);

  // ---------- 键盘翻页 / 点击半区翻页（与重排书对齐） ----------
  const turnPage = useCallback(
    (dir: 1 | -1) => {
      const next = currentPage + dir;
      if (next >= 1 && next <= pageCount) {
        scrollToPage(next);
        updateWindow();
      }
    },
    [currentPage, pageCount, scrollToPage, updateWindow],
  );

  useEffect(() => {
    if (state.phase !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      let dir: 1 | -1 | null = null;
      if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) dir = -1;
      else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") dir = 1;
      if (dir == null) return;
      e.preventDefault();
      turnPage(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.phase, turnPage]);

  // 点击左右半区翻页；有文本选区（选词/复制）时不翻页。
  const handleScrollClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      if (x < 0.5) turnPage(-1);
      else turnPage(1);
    },
    [turnPage],
  );

  // 卸载兜底：flush 尚未上报的进度（换书/关闭不丢最后一页）。
  useEffect(() => {
    return () => {
      if (reportTimerRef.current !== null) window.clearTimeout(reportTimerRef.current);
      const pending = pendingPageRef.current;
      if (pending != null && pending !== lastReportedPageRef.current) {
        onProgressRef.current({ chapterIdx: pending, charOffset: 0, percent: pending / pageCount });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount]);

  // ---------- 缩放：锚定可视位置 ----------
  const zoomBy = (dir: 1 | -1) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + dir * SCALE_STEP));
    if (next === scale) return;
    const node = scrollRef.current;
    if (node && totalHeight > 0) {
      anchorRatioRef.current = Math.min(1, Math.max(0, node.scrollTop / totalHeight));
    }
    setScale(next);
  };

  useEffect(() => {
    if (anchorRatioRef.current == null) return;
    const node = scrollRef.current;
    if (!node || totalHeight <= 0) return;
    node.scrollTop = anchorRatioRef.current * totalHeight;
    anchorRatioRef.current = null;
    updateWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, layout]);

  // ---------- 书签（直接 api，乐观 + 回滚） ----------
  const currentBookmark = bookmarks.find((b) => b.kind === "bookmark" && b.page === currentPage);

  const toggleBookmark = useCallback(() => {
    if (busyBookmarkRef.current || state.phase !== "ready") return;
    busyBookmarkRef.current = true;
    const prev = bookmarks;
    if (currentBookmark) {
      onBookmarksChange(prev.filter((b) => b.id !== currentBookmark.id));
      api
        .deleteAnnotation(currentBookmark.id)
        .catch((e) => {
          onBookmarksChange(prev);
          toast(describeError(e), "error");
        })
        .finally(() => {
          busyBookmarkRef.current = false;
        });
    } else {
      const temp: Annotation = {
        id: -Date.now(),
        bookId: book.id,
        kind: "bookmark",
        chapterIdx: 0,
        start: 0,
        end: 0,
        text: null,
        noteBody: null,
        color: "yellow",
        page: currentPage,
        createdAt: Math.floor(Date.now() / 1000),
      };
      onBookmarksChange([...prev, temp]);
      api
        .createAnnotation(book.id, "bookmark", 0, 0, 0, null, "yellow", currentPage)
        .then((saved) => {
          onBookmarksChange(prev.map((b) => (b.id === temp.id ? saved : b)));
        })
        .catch((e) => {
          onBookmarksChange(prev);
          toast(describeError(e), "error");
        })
        .finally(() => {
          busyBookmarkRef.current = false;
        });
    }
  }, [book.id, bookmarks, currentBookmark, currentPage, onBookmarksChange, state.phase]);

  // ---------- 大纲 ----------
  const jumpOutline = useCallback(
    async (dest: unknown) => {
      const pdf = loadedDocRef.current;
      if (!pdf) return;
      const page = await destToPage(pdf, dest);
      if (page == null || page < 1 || page > pdf.numPages) {
        toast("无法定位该目录项的位置。", "info");
        return;
      }
      scrollToPage(page);
      setOutlineOpen(false);
    },
    [scrollToPage],
  );

  // ---------- 渲染 ----------
  const windowPages =
    state.phase === "ready" && pages && windowRange ? pages.slice(windowRange[0], windowRange[1] + 1) : null;

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button
          type="button"
          className={currentBookmark && state.phase === "ready" ? "btn pdf-bookmark pdf-bookmark-active" : "btn pdf-bookmark"}
          disabled={state.phase !== "ready"}
          title={currentBookmark ? "删除本页书签" : "给本页加书签"}
          onClick={toggleBookmark}
        >
          {currentBookmark ? "★ 书签" : "☆ 书签"}
        </button>
        <span className="pdf-toolbar-sep" />
        <button
          type="button"
          className="btn"
          disabled={state.phase !== "ready" || scale <= MIN_SCALE}
          onClick={() => zoomBy(-1)}
          aria-label="缩小"
        >
          −
        </button>
        <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="btn"
          disabled={state.phase !== "ready" || scale >= MAX_SCALE}
          onClick={() => zoomBy(1)}
          aria-label="放大"
        >
          +
        </button>
        <span className="pdf-toolbar-sep" />
        <button
          type="button"
          className="btn"
          disabled={state.phase !== "ready" || !outline}
          onClick={() => setOutlineOpen((o) => !o)}
        >
          大纲
        </button>
        {state.phase === "ready" && pageCount > 0 ? (
          <span className="pdf-status">
            {currentPage} / {pageCount} 页
          </span>
        ) : null}
      </div>

      {state.phase === "loading" ? (
        <div className="pdf-center">
          <Spinner />
          <p>正在打开 PDF…</p>
        </div>
      ) : state.phase === "error" ? (
        <div className="pdf-center pdf-error">
          <p>{state.message}</p>
        </div>
      ) : (
        <div className="pdf-scroll" ref={scrollRef} onClick={handleScrollClick}>
          <div className="pdf-sheet" style={{ width: sheetWidth, height: totalHeight }}>
            {windowPages?.map((p) => (
              <PdfPageCanvas
                key={p.index}
                doc={doc!}
                index={p.index}
                scale={scale}
                left={p.left}
                width={p.width}
                height={p.height}
              />
            ))}
          </div>
        </div>
      )}

      {outlineOpen && outline && (
        <div className="pdf-outline-overlay" onClick={() => setOutlineOpen(false)}>
          <div className="pdf-outline-menu" onClick={(e) => e.stopPropagation()}>
            <header className="pdf-outline-header">
              <h3>{book.title}</h3>
              <button
                type="button"
                className="btn btn-ghost pdf-outline-close"
                onClick={() => setOutlineOpen(false)}
                aria-label="关闭大纲"
              >
                ×
              </button>
            </header>
            {outline.length === 0 ? (
              <p className="pdf-outline-empty">（本书没有目录大纲）</p>
            ) : (
              <ul className="pdf-outline-list">
                {outline.map((item, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="pdf-outline-item"
                      style={{ paddingLeft: 12 + item.depth * 14 }}
                      onClick={() => void jumpOutline(item.dest)}
                    >
                      {item.title || "（无标题）"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}