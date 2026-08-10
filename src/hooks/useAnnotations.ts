// 标注客户端状态（docs/architecture.md §6.5）：按书加载/维护 annotations
// 列表。所有变更乐观更新：先改本地，invoke 失败回滚并 Toast。
// create/update/delete 返回是否成功，供 AnnotationLayer 决定气泡去留。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError, toast } from "../lib/api";
import type { Annotation, AnnotationKind } from "../lib/types";

export interface AnnotationInput {
  kind: AnnotationKind;
  chapterIdx: number;
  start: number;
  end: number;
  text: string | null;
  color: string;
}

export interface UseAnnotationsResult {
  /** 全书标注（后端 list 顺序：chapter_idx, start）。 */
  items: Annotation[];
  loading: boolean;
  /** 指定章的标注（按 start 排序；书签 start=end=0 渲染时自然跳过）。 */
  chapterAnnotations: (chapterIdx: number) => Annotation[];
  /** 指定章是否已有书签（顶栏书签按钮禁用用）。 */
  hasBookmark: (chapterIdx: number) => boolean;
  /** 乐观新建；成功返回落库后的完整标注，失败回滚并返回 null（气泡保留）。 */
  create: (input: AnnotationInput) => Promise<Annotation | null>;
  /** 当前章加书签（kind=bookmark，start=end=0，text=null）。 */
  createBookmark: (chapterIdx: number) => Promise<Annotation | null>;
  /** 乐观部分更新（note_body / color）。失败回滚。 */
  update: (id: number, patch: { noteBody?: string; color?: string }) => Promise<boolean>;
  /** 乐观删除。失败回滚。 */
  remove: (id: number) => Promise<boolean>;
}

export function useAnnotations(bookId: number | null): UseAnnotationsResult {
  const [items, setItems] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(false);
  // 回滚快照：避免闭包里的过期 items。
  const itemsRef = useRef<Annotation[]>(items);
  itemsRef.current = items;

  // 换书加载；关闭（bookId→null）清空。
  useEffect(() => {
    if (bookId == null) {
      setItems([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .listAnnotations(bookId)
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch((e) => {
        if (alive) toast(describeError(e), "error");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [bookId]);

  const create = useCallback(
    async (input: AnnotationInput): Promise<Annotation | null> => {
      if (bookId == null) return null;
      // 临时行：负 id 占位，成功后替换为服务端真实行。
      const tempId = -Date.now() - Math.floor(Math.random() * 10000);
      const temp: Annotation = {
        id: tempId,
        bookId,
        kind: input.kind,
        chapterIdx: input.chapterIdx,
        start: input.start,
        end: input.end,
        text: input.text,
        noteBody: null,
        color: input.color,
        page: null,
        createdAt: Math.floor(Date.now() / 1000),
      };
      setItems((prev) => [...prev, temp]);
      try {
        const saved = await api.createAnnotation(
          bookId,
          input.kind,
          input.chapterIdx,
          input.start,
          input.end,
          input.text,
          input.color,
        );
        setItems((prev) => prev.map((a) => (a.id === tempId ? saved : a)));
        return saved;
      } catch (e) {
        setItems((prev) => prev.filter((a) => a.id !== tempId));
        toast(describeError(e), "error");
        return null;
      }
    },
    [bookId],
  );

  const createBookmark = useCallback(
    (chapterIdx: number) =>
      create({ kind: "bookmark", chapterIdx, start: 0, end: 0, text: null, color: "yellow" }),
    [create],
  );

  const update = useCallback(async (id: number, patch: { noteBody?: string; color?: string }) => {
    const snapshot = itemsRef.current;
    setItems((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              noteBody: patch.noteBody !== undefined ? patch.noteBody : a.noteBody,
              color: patch.color !== undefined ? patch.color : a.color,
            }
          : a,
      ),
    );
    try {
      await api.updateAnnotation(id, patch);
      return true;
    } catch (e) {
      setItems(snapshot);
      toast(describeError(e), "error");
      return false;
    }
  }, []);

  const remove = useCallback(async (id: number) => {
    const snapshot = itemsRef.current;
    setItems((prev) => prev.filter((a) => a.id !== id));
    try {
      await api.deleteAnnotation(id);
      return true;
    } catch (e) {
      setItems(snapshot);
      toast(describeError(e), "error");
      return false;
    }
  }, []);

  const chapterAnnotations = useCallback(
    (chapterIdx: number) =>
      items
        .filter((a) => a.chapterIdx === chapterIdx)
        .slice()
        .sort((a, b) => a.start - b.start),
    [items],
  );

  const hasBookmark = useCallback(
    (chapterIdx: number) =>
      items.some((a) => a.kind === "bookmark" && a.chapterIdx === chapterIdx),
    [items],
  );

  return useMemo(
    () => ({ items, loading, chapterAnnotations, hasBookmark, create, createBookmark, update, remove }),
    [items, loading, chapterAnnotations, hasBookmark, create, createBookmark, update, remove],
  );
}