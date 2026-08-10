// 重排正文渲染（docs/architecture.md §4.1 / §6.2）。
// paged：CSS columns 分页——章节 DOM 排入「列宽=页宽、高度=视口高、column-fill:
// auto」的多列容器，页数 = scrollWidth/列宽，翻页 = translateX；展示与度量共用
// 同一份 DOM，页断点天然一致。scroll：普通流 + 纵向滚动，章末自动续章。
// 进度上报：charOffset 为章内累计字符偏移（由 paginate 计算），percent 按字符
// 权重换算整书进度。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import type { Chapter, Element } from "../../../lib/types";
import type { ReadingProgress } from "../../../hooks/useProgress";
import type { FontFamily } from "../../../store/settingsStore";
import {
  chapterCharLength,
  charOffsetToPercent,
  computePageStarts,
  elementCharOffsets,
  findElementAtOffset,
  measurePageCount,
} from "./paginate";

const FONT_STACK: Record<FontFamily, string> = {
  "sans-serif": '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif',
  serif: '"Noto Serif CJK SC", "Songti SC", "SimSun", Georgia, serif',
  monospace: '"JetBrains Mono", Consolas, "Courier New", monospace',
};

// 章末/章首浮动按钮（paged 模式）
const PAGE_CLICK_ZONES = { prev: 0.3, next: 0.7 } as const;

export interface ChapterViewProps {
  /** 整本书的章节（book-level percent 换算用）。 */
  chapters: Chapter[];
  chapter: Chapter;
  chapterIdx: number;
  mode: "paged" | "scroll";
  fontSize: number;
  lineHeight: number;
  fontFamily: FontFamily;
  /** 进入本章的续读/跳转字符偏移；null 表示从头读。 */
  initialOffset: number | null;
  /** 翻页/滚动停止时上报当前进度。 */
  onProgress: (p: ReadingProgress) => void;
  /** 章首/章末翻章：dir = -1 上一章、1 下一章（由父组件收敛越界）。 */
  onChapterEnd: (dir: 1 | -1) => void;
  /** 正文容器挂载回调（AnnotationLayer 用）：paged 传分页容器，scroll 传滚动容器。 */
  onContentMount?: (el: HTMLElement | null) => void;
}

interface PageData {
  pageCount: number;
  /** pageStarts[k] = 第 k 页起始字符的章内偏移。 */
  pageStarts: number[];
}

export function ChapterView({
  chapters,
  chapter,
  chapterIdx,
  mode,
  fontSize,
  lineHeight,
  fontFamily,
  initialOffset,
  onProgress,
  onChapterEnd,
  onContentMount,
}: ChapterViewProps) {
  const isPaged = mode === "paged";
  const len = useMemo(() => chapterCharLength(chapter), [chapter]);
  const hasPrevChapter = chapterIdx > 0;
  const hasNextChapter = chapterIdx < chapters.length - 1;

  // ---------- 内容区尺寸（两种模式共用） ----------
  const areaRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      setSize({ w: Math.floor(cr.width), h: Math.floor(cr.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 字体相关设置直接驱动 inline CSS 变量，reader.css 消费。
  const contentVars = {
    "--reader-font-size": `${fontSize}px`,
    "--reader-line-height": `${lineHeight}`,
    "--reader-font-family": FONT_STACK[fontFamily],
  } as CSSProperties;

  // ---------- paged：分页状态与度量 ----------
  const pagerRef = useRef<HTMLDivElement>(null);
  /** 引用回调保持稳定：pager ↔ scroll 切换/挂载时把容器上报给 AnnotationLayer。 */
  const mountPager = useCallback(
    (el: HTMLDivElement | null) => {
      pagerRef.current = el;
      onContentMount?.(el);
    },
    [onContentMount],
  );
  const [page, setPage] = useState(0);
  const [measured, setMeasured] = useState<PageData | null>(null);
  const [measureTick, setMeasureTick] = useState(0);
  /** 初始定位只做一次：字体/尺寸变化重测时不再回跳。 */
  const placedRef = useRef(false);
  /** 翻页过渡（M6）：用户显式翻页后才启用滑动动画；初始定位/重测不播，
   *  避免续读定位从第 0 页横跨滑到第 N 页。 */
  const [anim, setAnim] = useState(false);
  /** 图片加载完成后布局变化，重测页数。 */
  const bumpMeasure = useCallback(() => setMeasureTick((t) => t + 1), []);

  useLayoutEffect(() => {
    if (!isPaged || size.w <= 0 || size.h <= 0) return;
    const pager = pagerRef.current;
    if (!pager) return;
    const pageCount = measurePageCount(pager, { contentWidth: size.w, pageHeight: size.h });
    const offsets = elementCharOffsets(chapter.content);
    const pageStarts = computePageStarts(pager, offsets, size.w, pageCount);
    setMeasured({ pageCount, pageStarts });

    if (!placedRef.current) {
      placedRef.current = true;
      let startPage = 0;
      if (initialOffset != null) {
        // 定位到包含该字符偏移的页（页边界按元素粒度）。
        const clamped = Math.min(Math.max(initialOffset, 0), len);
        const elIdx = findElementAtOffset(chapter.content, clamped);
        const elOffset = offsets[elIdx] ?? 0;
        let k = 0;
        while (k < pageCount - 1 && pageStarts[k + 1] <= elOffset) k += 1;
        startPage = k;
      }
      setPage(startPage);
    }
  }, [isPaged, size.w, size.h, chapter, len, measureTick, initialOffset, fontSize, lineHeight, fontFamily]);

  // 字体加载完成后补一次重测（列布局可能因字形替换而变）。
  useEffect(() => {
    if (!isPaged) return;
    let alive = true;
    document.fonts
      ?.ready?.then(() => {
        if (alive) setMeasureTick((t) => t + 1);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isPaged]);

  // 页数收缩时把当前页收敛进界。
  useEffect(() => {
    if (measured && page >= measured.pageCount) {
      setPage(Math.max(0, measured.pageCount - 1));
    }
  }, [measured, page]);

  const pageCount = measured?.pageCount ?? 1;

  const goPrev = useCallback(() => {
    if (page > 0) {
      setAnim(true);
      setPage(page - 1);
    } else if (hasPrevChapter) onChapterEnd(-1);
  }, [page, hasPrevChapter, onChapterEnd]);

  const goNext = useCallback(() => {
    if (page < pageCount - 1) {
      setAnim(true);
      setPage(page + 1);
    } else if (hasNextChapter) onChapterEnd(1);
  }, [page, pageCount, hasNextChapter, onChapterEnd]);

  // ←/→ 翻页（仅 paged 模式；防止页面滚动被连带触发）。
  useEffect(() => {
    if (!isPaged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPaged, goPrev, goNext]);

  // 点击左右区域翻页；有文字选区时视为选词，不翻页。
  const handleViewportClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      if (x < PAGE_CLICK_ZONES.prev) goPrev();
      else if (x > PAGE_CLICK_ZONES.next) goNext();
    },
    [goPrev, goNext],
  );

  // 分页进度上报：页变化/重测（字号行距变化改了页边界）都上报。
  useEffect(() => {
    if (!isPaged || !measured) return;
    const charOffset = Math.min(
      measured.pageStarts[Math.min(page, measured.pageCount - 1)] ?? len,
      len,
    );
    onProgress({
      chapterIdx,
      charOffset,
      percent: charOffsetToPercent(chapters, chapterIdx, charOffset),
    });
  }, [isPaged, page, measured, chapterIdx, chapters, len, onProgress]);

  // ---------- scroll：滚动进度与续读定位 ----------
  const scrollRef = useRef<HTMLDivElement>(null);
  const mountScroll = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      onContentMount?.(el);
    },
    [onContentMount],
  );
  const lastOffsetRef = useRef<number | null>(null);
  const scrollPlacedRef = useRef(false);

  // 滚动模式下上报（阈值去抖，避免滚动帧级状态风暴）。
  const reportOffset = useCallback(
    (charOffset: number, force: boolean) => {
      const clamped = Math.min(Math.max(charOffset, 0), len);
      const last = lastOffsetRef.current;
      if (!force && last !== null && Math.abs(clamped - last) < Math.max(2, Math.floor(len * 0.002))) {
        return;
      }
      lastOffsetRef.current = clamped;
      onProgress({
        chapterIdx,
        charOffset: clamped,
        percent: charOffsetToPercent(chapters, chapterIdx, clamped),
      });
    },
    [len, chapterIdx, chapters, onProgress],
  );

  // 续读定位：滚动到偏移对应的比例位置（每个章节实例只做一次）。
  useLayoutEffect(() => {
    if (isPaged) return;
    const sc = scrollRef.current;
    if (!sc || scrollPlacedRef.current) return;
    scrollPlacedRef.current = true;
    if (initialOffset != null && len > 0) {
      const frac = Math.min(1, Math.max(0, initialOffset / len));
      sc.scrollTop = frac * Math.max(0, sc.scrollHeight - sc.clientHeight);
    }
  }, [isPaged, len, initialOffset]);

  const handleScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const max = sc.scrollHeight - sc.clientHeight;
    const frac = max > 0 ? sc.scrollTop / max : 0;
    reportOffset(Math.round(frac * len), false);
    // 滚动到章末自动续读下一章。
    if (frac >= 0.995 && hasNextChapter) onChapterEnd(1);
  }, [len, reportOffset, hasNextChapter, onChapterEnd]);

  // ---------- 元素渲染 ----------
  const renderElement = useCallback(
    (el: Element, i: number): ReactNode => {
      switch (el.kind) {
        case "heading":
          return (
            <h2 key={i} className="chapter-h">
              {el.text}
            </h2>
          );
        case "paragraph":
          return (
            <p key={i} className="chapter-p">
              {el.text}
            </p>
          );
        case "image":
          return (
            <img
              key={i}
              className="chapter-img"
              src={el.src}
              alt=""
              loading="lazy"
              onLoad={bumpMeasure}
            />
          );
      }
    },
    [bumpMeasure],
  );

  return (
    <div className="chapter-area" ref={areaRef} style={contentVars}>
      {isPaged ? (
        <div
          className="chapter-viewport"
          style={{ width: size.w, height: size.h }}
          onClick={handleViewportClick}
        >
          <div
            ref={mountPager}
            className={anim ? "chapter-pager chapter-pager-anim" : "chapter-pager"}
            style={{
              columnWidth: size.w,
              transform: page > 0 ? `translateX(${-page * size.w}px)` : undefined,
            }}
          >
            {chapter.content.map((el, i) => renderElement(el, i))}
          </div>

          {hasPrevChapter && page === 0 && (
            <button
              className="btn chapter-nav chapter-nav-prev"
              onClick={(e) => {
                e.stopPropagation();
                onChapterEnd(-1);
              }}
            >
              ← 上一章
            </button>
          )}
          {hasNextChapter && page === pageCount - 1 && (
            <button
              className="btn chapter-nav chapter-nav-next"
              onClick={(e) => {
                e.stopPropagation();
                onChapterEnd(1);
              }}
            >
              下一章 →
            </button>
          )}
          <span className="chapter-page-indicator">
            {page + 1} / {pageCount}
          </span>
        </div>
      ) : (
        <div className="chapter-scroll" ref={mountScroll} onScroll={handleScroll}>
          {chapter.content.map((el, i) => renderElement(el, i))}
          {hasNextChapter && (
            <button className="btn chapter-scroll-end" onClick={() => onChapterEnd(1)}>
              下一章 →
            </button>
          )}
        </div>
      )}
    </div>
  );
}