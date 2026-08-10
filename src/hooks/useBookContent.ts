// 正文内容组装（docs/architecture.md §6.2）：open_book 返回的模型是纯数据，
// 本章 hook 把各章节 resources 的 path 经 assetUrl 转为可加载 URL，并让
// Element::Image 的 src 一律指向资源 URL，产出可直接渲染的 chapters 副本。

import { useMemo } from "react";
import { assetUrl } from "../lib/assets";
import type { Chapter, Element, OpenBook } from "../lib/types";

/** 图片元素的 src 指向 Resource.id，这里解析出资源路径并转为 asset URL。 */
function resolveImageSrc(el: Extract<Element, { kind: "image" }>, chapter: Chapter): string {
  const res = chapter.resources.find((r) => r.id === el.src);
  return assetUrl(res?.path ?? el.src);
}

/** 根据 open 结果返回图片 URL 已解析的章节数组；open 为空时返回 null。 */
export function useBookContent(open: OpenBook | null): Chapter[] | null {
  return useMemo(() => {
    if (!open) return null;
    return open.model.chapters.map((chapter) => ({
      ...chapter,
      content: chapter.content.map((el) =>
        el.kind === "image" ? { ...el, src: resolveImageSrc(el, chapter) } : el,
      ),
    }));
  }, [open]);
}