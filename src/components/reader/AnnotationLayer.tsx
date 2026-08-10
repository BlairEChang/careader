// 高亮层（docs/architecture.md §6.5）：渲染 <mark> 包裹 + 选区换算 + 气泡。
//
// 与 ChapterView 的解耦方式：
//   - 渲染：useLayoutEffect 里直接操作正文 DOM（包裹/还原文本节点）。
//     <mark> 是内联元素、文本语义不变，不改变布局与分页测量；ChapterView
//     重渲染时仅比对同一段文本，不会触碰被标记的节点（章节内容不可变）。
//   - 交互：原生监听伪容器（pager/scroll）的 mouseup/click，与 React 事件
//     互补（点击翻页、选中即弹气泡互不冲突）。
//   - 气泡：fixed 定位悬浮层，绘制在正文之外，不参与正文布局。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Annotation, Chapter } from "../../lib/types";
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_HEX,
  renderHighlights,
  selectionToChapterSpan,
} from "../../lib/annotations";

const BUBBLE_W = 268;
const BUBBLE_H = 220;
const MARGIN = 8;

interface CreateDraft {
  x: number;
  y: number;
  start: number;
  end: number;
  text: string;
}

interface EditDraft {
  annotation: Annotation;
  x: number;
  y: number;
  note: string;
  color: string;
}

export interface AnnotationLayerProps {
  /** 当前正文容器（ChapterView 的 pager / scroll），空则跳过全部效果。 */
  container: HTMLElement | null;
  chapter: Chapter;
  /** 当前章索引（新建标注落库用）。 */
  chapterIdx: number;
  /** 当前章标注（含书签；书签无区间，渲染自动跳过）。 */
  annotations: Annotation[];
  /** 新建高亮；返回落库标注，失败返回 null（保留气泡便于重试）。 */
  onCreate: (input: {
    kind: "highlight";
    chapterIdx: number;
    start: number;
    end: number;
    text: string;
    color: string;
  }) => Promise<Annotation | null>;
  /** 部分更新（note_body / color）。 */
  onUpdate: (id: number, patch: { noteBody?: string; color?: string }) => Promise<boolean>;
  onDelete: (id: number) => Promise<boolean>;
}

export function AnnotationLayer({
  container,
  chapter,
  chapterIdx,
  annotations,
  onCreate,
  onUpdate,
  onDelete,
}: AnnotationLayerProps) {
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [createNote, setCreateNote] = useState("");
  const [createColor, setCreateColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  /** mouseup 刚打开/关闭气泡 → 紧随其后的 click 吞掉，防止翻页。 */
  const suppressClickRef = useRef(false);

  // ---------- 高亮渲染 ----------
  useLayoutEffect(() => {
    if (!container) return;
    renderHighlights(container, chapter, annotations);
  }, [container, chapter, annotations]);

  // ---------- 气泡定位 ----------
  const clamp = (x: number, y: number): { x: number; y: number } => ({
    x: Math.min(Math.max(x + 12, MARGIN), window.innerWidth - BUBBLE_W - MARGIN),
    y: Math.min(Math.max(y + 14, MARGIN), window.innerHeight - BUBBLE_H - MARGIN),
  });

  const closeCreate = () => {
    setCreateDraft(null);
    setCreateNote("");
  };

  const closeEdit = () => {
    setEditDraft(null);
  };

  /** 关闭编辑气泡：note 有改动则保存（气泡关闭时保存）。 */
  const commitEdit = () => {
    const draft = editDraft;
    if (!draft) return;
    const note = draft.note.trim();
    const original = draft.annotation.noteBody ?? "";
    if (note !== original) {
      void onUpdate(draft.annotation.id, { noteBody: note });
    }
    closeEdit();
  };

  const clearSelection = () => {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  };

  const openCreate = (x: number, y: number, span: { start: number; end: number; text: string }) => {
    closeEdit();
    suppressClickRef.current = true;
    setCreateColor(ANNOTATION_COLORS[0]);
    setCreateDraft({ ...clamp(x, y), ...span });
  };

  const openEdit = (ann: Annotation, markEl: HTMLElement) => {
    closeCreate();
    suppressClickRef.current = true;
    const rect = markEl.getBoundingClientRect();
    setEditDraft({
      annotation: ann,
      x: Math.min(Math.max(rect.left, MARGIN), window.innerWidth - BUBBLE_W - MARGIN),
      y: Math.min(Math.max(rect.top - 4, MARGIN), window.innerHeight - BUBBLE_H - MARGIN),
      note: ann.noteBody ?? "",
      color: ann.color || ANNOTATION_COLORS[0],
    });
    clearSelection();
  };

  // ---------- 交互（原生监听，避免 React 合成事件与翻页点击耦合） ----------
  useEffect(() => {
    if (!container) return;
    const onMouseUp = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const markEl = target?.closest("mark.hl") as HTMLElement | null;
      if (markEl) {
        const id = Number(markEl.getAttribute("data-annotation-id"));
        const ann = annotations.find((a) => a.id === id);
        if (ann) {
          openEdit(ann, markEl);
          return;
        }
      }
      const span = selectionToChapterSpan(container, chapter);
      if (span) {
        openCreate(e.clientX, e.clientY, span);
      }
    };
    // capture：点击标记/刚弹过气泡时拦下，避免 ChapterView 的翻页点击。
    const onClickCapture = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (target?.closest("mark.hl")) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("click", onClickCapture, true);
    return () => {
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("click", onClickCapture, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, chapter, annotations]);

  // 点击气泡外部：关闭（编辑气泡同时保存）；Esc 关闭编辑气泡。
  useEffect(() => {
    if (!createDraft && !editDraft) return;
    const onMouseDown = (e: MouseEvent) => {
      if (bubbleRef.current && !bubbleRef.current.contains(e.target as Node)) {
        suppressClickRef.current = true;
        if (editDraft) commitEdit();
        else closeCreate();
        clearSelection();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editDraft) {
          commitEdit();
          clearSelection();
        } else if (createDraft) {
          closeCreate();
          clearSelection();
        }
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createDraft, editDraft]);

  // ---------- 保存动作 ----------
  const saveCreate = async () => {
    if (!createDraft || busy) return;
    setBusy(true);
    const saved = await onCreate({
      kind: "highlight",
      chapterIdx,
      start: createDraft.start,
      end: createDraft.end,
      text: createDraft.text,
      color: createColor,
    });
    setBusy(false);
    if (saved && createNote.trim()) {
      // 创建接口不含 note_body：有笔记则紧随补一条 update。
      await onUpdate(saved.id, { noteBody: createNote.trim() });
    }
    if (saved) {
      closeCreate();
      clearSelection();
    }
    // 失败：保留气泡，用户可改色/重试或点取消。
  };

  const swapColor = (color: string) => {
    if (editDraft) {
      setEditDraft({ ...editDraft, color });
      void onUpdate(editDraft.annotation.id, { color });
    } else {
      setCreateColor(color);
    }
  };

  const removeEdit = async () => {
    const draft = editDraft;
    if (!draft || busy) return;
    setBusy(true);
    const ok = await onDelete(draft.annotation.id);
    setBusy(false);
    if (ok) {
      closeEdit();
      clearSelection();
    }
  };

  const bubble = createDraft || editDraft;

  return (
    <>
      {bubble && (
        <div
          ref={bubbleRef}
          className="annotation-bubble"
          style={{ left: bubble.x, top: bubble.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {createDraft ? (
            <>
              <p className="annotation-bubble-quote">“{createDraft.text}”</p>
              <textarea
                className="annotation-bubble-note"
                placeholder="笔记（可选，留空即纯高亮）"
                value={createNote}
                onChange={(e) => setCreateNote(e.target.value)}
                autoFocus
              />
              <div className="annotation-bubble-colors">
                {ANNOTATION_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={
                      c === createColor
                        ? "annotation-bubble-color annotation-bubble-color-active"
                        : "annotation-bubble-color"
                    }
                    style={{ background: ANNOTATION_COLOR_HEX[c] }}
                    aria-label={`颜色 ${c}`}
                    onClick={() => setCreateColor(c)}
                  />
                ))}
              </div>
              <div className="annotation-bubble-actions">
                <button type="button" className="btn" disabled={busy} onClick={saveCreate}>
                  保存
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    closeCreate();
                    clearSelection();
                  }}
                >
                  取消
                </button>
              </div>
            </>
          ) : editDraft ? (
            <>
              <header className="annotation-bubble-head">
                <span className="annotation-bubble-kind">高亮</span>
                <button
                  type="button"
                  className="btn btn-ghost annotation-bubble-close"
                  onClick={() => {
                    commitEdit();
                    clearSelection();
                  }}
                  aria-label="关闭并保存"
                >
                  ×
                </button>
              </header>
              <p className="annotation-bubble-quote">“{editDraft.annotation.text}”</p>
              <textarea
                className="annotation-bubble-note"
                placeholder="笔记（留空删除笔记内容）"
                value={editDraft.note}
                onChange={(e) => setEditDraft({ ...editDraft, note: e.target.value })}
                autoFocus
              />
              <div className="annotation-bubble-colors">
                {ANNOTATION_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={
                      c === editDraft.color
                        ? "annotation-bubble-color annotation-bubble-color-active"
                        : "annotation-bubble-color"
                    }
                    style={{ background: ANNOTATION_COLOR_HEX[c] }}
                    aria-label={`颜色 ${c}`}
                    onClick={() => swapColor(c)}
                  />
                ))}
              </div>
              <div className="annotation-bubble-actions">
                <button type="button" className="btn btn-ghost annotation-bubble-delete" disabled={busy} onClick={() => void removeEdit()}>
                  删除
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    commitEdit();
                    clearSelection();
                  }}
                >
                  完成
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </>
  );
}