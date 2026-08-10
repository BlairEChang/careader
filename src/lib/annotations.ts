// 高亮坐标换算工具（docs/architecture.md §6.5）。
//
// 偏移语义与 paginate.ts 完全一致：章内字符偏移 = 章内所有文本元素
// （heading/paragraph；image 计 0 字符）按序拼接的 JS 字符串（UTF-16 码元）
// 索引，落到 Rust 侧为不透明的 i64，无需在两端换算。
//
// 本文件提供两组方向相反的换算：
//   - DOM 选区 → 章内 [start, end) + 原文快照（selectionToChapterSpan）
//   - 标注区间 → <mark> 包裹（renderHighlights，逐段切分、先到先得）
// 与 ChapterView 的 DOM 契约：正文元素类名 `.chapter-p` / `.chapter-h`，
// 渲染顺序 = chapter.content 中非 image 元素的顺序。

import type { Annotation, Chapter } from "./types";
import {
  elementCharLength,
  elementCharOffsets,
} from "../components/reader/reflowable/paginate";

export const ANNOTATION_COLORS = ["yellow", "orange", "green", "blue", "purple"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

/** 调色板 HEX（气泡色块 / 笔记列表色点用），与 reader.css 的 .hl-* 背景一致。 */
export const ANNOTATION_COLOR_HEX: Record<AnnotationColor, string> = {
  yellow: "#e9c23f",
  orange: "#e08a3c",
  green: "#7cb25a",
  blue: "#5b9bd5",
  purple: "#9b7fd4",
};

/** 颜色 → HEX；未知颜色（后端容忍任意字符串）回退为黄色。 */
export function annotationColorHex(color: string): string {
  return ANNOTATION_COLOR_HEX[color as AnnotationColor] ?? ANNOTATION_COLOR_HEX.yellow;
}

/** 章内文本承载元素的选择器（与 ChapterView 渲染的类名对齐）。 */
export const TEXT_ELEMENT_SELECTOR = ".chapter-p, .chapter-h";

/** 章节平铺文本（image 不占字符），与 elementCharOffsets 同一坐标域。 */
export function chapterFlatText(chapter: Chapter): string {
  let text = "";
  for (const el of chapter.content) {
    if (el.kind !== "image") text += el.text;
  }
  return text;
}

export interface ParaRef {
  el: HTMLElement;
  /** 对应元素在 chapter.content 中的下标（image 跳过，对齐 offsets）。 */
  contentIdx: number;
}

/** 容器内正文元素 → 与章内元素一一对应的段落引用（DOM 顺序 = 内容顺序）。 */
export function textElements(container: HTMLElement, chapter: Chapter): ParaRef[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(TEXT_ELEMENT_SELECTOR));
  const paras: ParaRef[] = [];
  let k = 0;
  for (let i = 0; i < chapter.content.length; i++) {
    if (chapter.content[i].kind === "image") continue;
    const el = nodes[k];
    if (!el) break;
    paras.push({ el, contentIdx: i });
    k += 1;
  }
  return paras;
}

export interface TextRun {
  node: Text;
  /** 元素内字符起（含）。 */
  start: number;
  /** 元素内字符止（不含）。 */
  end: number;
}

/** 元素内文本游走：递归（mark 等内联元素内部也算），产出有序文本 run。 */
export function elementTextRuns(root: Node): TextRun[] {
  const runs: TextRun[] = [];
  let acc = 0;
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = n.nodeValue?.length ?? 0;
      if (len > 0) runs.push({ node: n as Text, start: acc, end: acc + len });
      acc += len;
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      for (const c of n.childNodes) walk(c);
    }
  };
  walk(root);
  return runs;
}

/** 段落内祖先查找：node 自身或祖先命中正文元素即返回（Text 节点先上溯）。 */
function findPara(node: Node | null, paras: ParaRef[]): ParaRef | null {
  let n: Node | null = node;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      for (const p of paras) {
        if (p.el === n) return p;
      }
    }
    n = n.parentNode;
  }
  return null;
}

/**
 * DOM 边界点（node, offset）→ 段落内字符偏移。
 * 用 Range 从段首数到边界点：文本节点与元素子节点边界统一处理，
 * 天然兼容 <mark> 包裹后的文本（不依赖节点结构）。
 */
function boundaryToParaOffset(paraEl: HTMLElement, node: Node, offset: number): number {
  try {
    const range = document.createRange();
    range.setStart(paraEl, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return 0;
  }
}

export interface SelectionSpan {
  /** 章内字符起（UTF-16 码元）。 */
  start: number;
  end: number;
  /** 原文快照（平铺文本切片，与 DOM 选区一致）。 */
  text: string;
}

/**
 * window.getSelection() → 章内字符区间。
 * 返回 null 的情况：无选区 / 折叠（单点击）/ 两端越出正文（如图片、顶栏）/
 * 纯空白选区。选区跨多段时返回单条跨段区间（渲染时逐段切分）。
 */
export function selectionToChapterSpan(
  container: HTMLElement,
  chapter: Chapter,
): SelectionSpan | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  if (!sel.anchorNode || !sel.focusNode) return null;
  const paras = textElements(container, chapter);
  if (paras.length === 0) return null;
  const anchorPara = findPara(sel.anchorNode, paras);
  const focusPara = findPara(sel.focusNode, paras);
  if (!anchorPara || !focusPara) return null;

  const offsets = elementCharOffsets(chapter.content);
  const anchorLocal = boundaryToParaOffset(anchorPara.el, sel.anchorNode, sel.anchorOffset);
  const focusLocal = boundaryToParaOffset(focusPara.el, sel.focusNode, sel.focusOffset);
  let start = offsets[anchorPara.contentIdx] + anchorLocal;
  let end = offsets[focusPara.contentIdx] + focusLocal;
  // 反向选区（从后往前拖）：交换
  if (
    anchorPara.contentIdx > focusPara.contentIdx ||
    (anchorPara.contentIdx === focusPara.contentIdx && anchorLocal > focusLocal)
  ) {
    [start, end] = [end, start];
  }
  if (end - start <= 0) return null;
  const text = chapterFlatText(chapter).slice(start, end);
  if (!text.trim()) return null;
  return { start, end, text };
}

/** 清除容器内既有高亮标记，还原纯文本节点（重新包裹前调用）。 */
function clearHighlights(container: HTMLElement): void {
  const marks = Array.from(container.querySelectorAll("mark.hl"));
  for (const mark of marks) {
    mark.replaceWith(...Array.from(mark.childNodes));
  }
}

/** 把一个元素内字符区间 [s, e) 包进 <mark>；跳过已被其他标注包裹的文本。 */
function wrapParaRange(para: HTMLElement, s: number, e: number, ann: Annotation): void {
  const runs = elementTextRuns(para).filter((r) => !r.node.parentElement?.closest("mark.hl"));
  for (const run of runs) {
    const cStart = Math.max(s, run.start);
    const cEnd = Math.min(e, run.end);
    if (cStart >= cEnd) continue;
    // 切分文本节点：目标范围拆成独立节点再包裹（splitText 不改变文本语义）。
    let node: Text = run.node;
    if (cStart > run.start) node = node.splitText(cStart - run.start);
    if (cEnd < run.end) node.splitText(cEnd - cStart);
    const mark = document.createElement("mark");
    mark.className = `hl hl-${ann.color || "yellow"}`;
    mark.dataset.annotationId = String(ann.id);
    node.parentNode?.insertBefore(mark, node);
    mark.appendChild(node);
  }
}

/**
 * 将当前章的高亮标注渲染为 <mark class="hl hl-{color}" data-annotation-id>：
 *   1) 先清掉旧标记（还原文本节点），保证幂等；
 *   2) 每个标注按元素逐段切分（跨段高亮拆成多段包裹）；
 *   3) 重叠区间「先到先得」：后应用的标注自动跳过已被包裹的文本。
 * 书签 / note（无文本区间）跳过。内联 <mark> 不改变布局与分页测量。
 */
export function renderHighlights(
  container: HTMLElement,
  chapter: Chapter,
  annotations: Annotation[],
): void {
  clearHighlights(container);
  const paras = textElements(container, chapter);
  const highlights = annotations
    .filter((a) => a.kind === "highlight" && a.text != null && a.end > a.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  if (highlights.length === 0 || paras.length === 0) return;

  const offsets = elementCharOffsets(chapter.content);
  const flatLen = chapterFlatText(chapter).length;
  for (const ann of highlights) {
    const segStart = Math.min(Math.max(ann.start, 0), flatLen);
    const segEnd = Math.min(Math.max(ann.end, 0), flatLen);
    if (segEnd <= segStart) continue;
    for (const para of paras) {
      const el = chapter.content[para.contentIdx];
      const len = elementCharLength(el);
      const base = offsets[para.contentIdx];
      const s = Math.max(segStart - base, 0);
      const e = Math.min(segEnd - base, len);
      if (s >= e) continue;
      wrapParaRange(para.el, s, e, ann);
    }
  }
}