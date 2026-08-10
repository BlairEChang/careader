// 分页计算（docs/architecture.md §4.1：CSS columns 测量）。
//
// 方案：章节 DOM 排入固定高度（视口高）× 固定列宽（内容区宽）的多列容器，
// `column-fill: auto` 让内容逐列垂直填充、超出一页的部分溢出到下一列
//（容器横向溢出）。于是：
//   - 页数 = 容器 scrollWidth / 列宽（列间距为 0）；
//   - 显示第 k 页 = 容器 translateX(-k × 列宽)，外框 overflow: hidden。
// 展示与测量共用同一份 DOM/样式，页断点天然一致（无需隐藏度量容器）。
//
// 下面的纯函数不依赖 DOM（可脱离浏览器单测）；DOM 测量在 ChapterView 里做。

import type { Chapter, Element } from "../../../lib/types";

// ---------- 字符长度与偏移（纯函数） ----------

/** 单个元素的字符长度；图片不计字符。 */
export function elementCharLength(el: Element): number {
  return el.kind === "image" ? 0 : el.text.length;
}

/** 章节累计字符数。 */
export function chapterCharLength(chapter: Chapter): number {
  return chapter.content.reduce((sum, el) => sum + elementCharLength(el), 0);
}

/** 整本书累计字符数。 */
export function chaptersCharLength(chapters: Chapter[]): number {
  return chapters.reduce((sum, c) => sum + chapterCharLength(c), 0);
}

/** 每个元素在章内的起始字符偏移（前缀和）。 */
export function elementCharOffsets(elements: Element[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const el of elements) {
    offsets.push(acc);
    acc += elementCharLength(el);
  }
  return offsets;
}

/** 章内字符偏移 → 所在元素下标（越界时收敛到 0 或末尾元素）。 */
export function findElementAtOffset(elements: Element[], charOffset: number): number {
  const lens = elements.map(elementCharLength);
  let acc = 0;
  for (let i = 0; i < elements.length; i++) {
    if (charOffset <= acc + lens[i]) return i;
    acc += lens[i];
  }
  return Math.max(0, elements.length - 1);
}

export interface Slice {
  /** 参与切片的首元素下标。 */
  startIndex: number;
  /** 参与切片的末元素下标（含）。 */
  endIndex: number;
  /** 首元素内从第几个字符开始（元素内部切片用）。 */
  startInElement: number;
  /** 末元素内到第几个字符结束。 */
  endInElement: number;
}

/**
 * 用 [startChar, endChar) 字符区间切元素序列：返回与区间相交的元素范围
 * 及首尾元素内部的子区间（中间元素视为整取）。
 */
export function sliceByOffset(elements: Element[], startChar: number, endChar: number): Slice {
  const offsets = elementCharOffsets(elements);
  const lens = elements.map(elementCharLength);
  const len = elements.length;
  const slice: Slice = { startIndex: len - 1, endIndex: 0, startInElement: 0, endInElement: 0 };

  for (let i = 0; i < len; i++) {
    if (lens[i] === 0) continue;
    const from = offsets[i];
    const to = from + lens[i];
    if (slice.startIndex === len - 1 && startChar < to) {
      slice.startIndex = i;
      slice.startInElement = Math.max(0, startChar - from);
    }
    if (endChar >= from) {
      slice.endIndex = i;
      slice.endInElement = Math.min(lens[i], endChar - from);
    }
  }
  if (len === 0) return { startIndex: 0, endIndex: -1, startInElement: 0, endInElement: 0 };
  return slice;
}

// ---------- 章/书百分比换算（纯函数） ----------

export interface ChapterOffset {
  chapterIdx: number;
  charOffset: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 章内偏移 → 整书 percent（按字符加权；无正文返回 0）。 */
export function charOffsetToPercent(
  chapters: Chapter[],
  chapterIdx: number,
  charOffset: number,
): number {
  const total = chaptersCharLength(chapters);
  if (total <= 0) return 0;
  let before = 0;
  for (let i = 0; i < chapterIdx && i < chapters.length; i++) {
    before += chapterCharLength(chapters[i]);
  }
  const chapter =
    chapterIdx >= 0 && chapterIdx < chapters.length ? chapters[chapterIdx] : undefined;
  const inChapter = Math.min(
    Math.max(charOffset, 0),
    chapter ? chapterCharLength(chapter) : 0,
  );
  return clamp01((before + inChapter) / total);
}

/** 整书 percent → { 章下标, 章内偏移 }（ProgressBar 点击跳转用）。 */
export function percentToChapterOffset(chapters: Chapter[], percent: number): ChapterOffset {
  const total = chaptersCharLength(chapters);
  if (total <= 0 || chapters.length === 0) return { chapterIdx: 0, charOffset: 0 };
  let target = clamp01(percent) * total;
  for (let i = 0; i < chapters.length; i++) {
    const len = chapterCharLength(chapters[i]);
    if (target <= len) return { chapterIdx: i, charOffset: Math.round(target) };
    target -= len;
  }
  const last = chapters.length - 1;
  return { chapterIdx: last, charOffset: chapterCharLength(chapters[last]) };
}

// ---------- 分页测量（依赖 DOM，在 ChapterView 中使用） ----------

export interface PageMetrics {
  /** 内容列宽（px），即每页宽度。 */
  contentWidth: number;
  /** 页高（px），即内容区可视高度。 */
  pageHeight: number;
}

/**
 * 页数 = 多列容器横向溢出 / 列宽（列间距为 0，取整防亚像素误差）。
 * 调用方需保证容器已按 metrics 布局（height=pageHeight, column-width=contentWidth,
 * column-fill: auto, column-gap: 0）。
 */
export function measurePageCount(pager: HTMLElement, metrics: PageMetrics): number {
  const width = Math.max(1, Math.floor(metrics.contentWidth));
  return Math.max(1, Math.round(pager.scrollWidth / width));
}

/**
 * 测量每个元素起始所在的页（跨页元素归入其起始页），并据此算每页起始
 * 字符偏移。pages 以页数组返回：pages[k] = 第 k 页正文的章内起始字符。
 * 空章返回页数 1、起始 0。
 */
export function computePageStarts(
  pager: HTMLElement,
  offsets: number[],
  contentWidth: number,
  pageCount: number,
): number[] {
  const pages = new Array<number>(pageCount).fill(0);
  const pagerLeft = pager.getBoundingClientRect().left;
  const width = Math.max(1, Math.floor(contentWidth));
  let filled = 0;
  const children = Array.from(pager.children);
  for (let i = 0; i < children.length && i < offsets.length; i++) {
    const left = (children[i] as HTMLElement).getBoundingClientRect().left;
    const pageIdx = Math.min(pageCount - 1, Math.max(0, Math.floor((left - pagerLeft + 1) / width)));
    if (pageIdx > filled) {
      for (let k = filled; k < pageIdx; k++) pages[k] = offsets[i];
      filled = pageIdx;
    }
  }
  for (let k = filled; k < pageCount; k++) pages[k] = offsets[offsets.length - 1] ?? 0;
  return pages;
}