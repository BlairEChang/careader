// 整书笔记/书签列表（docs/architecture.md §6.5 / §4）：按 created_at 倒序，
// 高亮显示原文 + 笔记 + 章名，书签显示章名；点击跳转到章节+偏移，可删除。

import { useMemo } from "react";
import type { Annotation, Chapter } from "../../lib/types";
import { annotationColorHex } from "../../lib/annotations";

interface NotesPanelProps {
  open: boolean;
  /** 整书章节（章名映射用）。 */
  chapters: Chapter[];
  /** 全书标注（任意顺序，内部按 created_at 倒序）。 */
  items: Annotation[];
  onClose: () => void;
  /** 点击跳转到该标注位置（父组件负责 seek + jump）。 */
  onJump: (a: Annotation) => void;
  /** 删除标注。 */
  onDelete: (id: number) => void;
}

const KIND_LABEL: Record<Annotation["kind"], string> = {
  highlight: "高亮",
  note: "笔记",
  bookmark: "书签",
};

export function NotesPanel({ open, chapters, items, onClose, onJump, onDelete }: NotesPanelProps) {
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.createdAt - a.createdAt),
    [items],
  );

  if (!open) return null;

  return (
    <div className="notes-overlay" onClick={onClose}>
      <aside
        className="notes-drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label="笔记与书签"
      >
        <header className="notes-header">
          <h3>笔记 · 书签</h3>
          <button className="btn btn-ghost notes-close" onClick={onClose} aria-label="关闭笔记">
            ×
          </button>
        </header>
        {sorted.length === 0 ? (
          <p className="notes-empty">
            暂无笔记与书签。
            <br />
            在正文选中文字即可高亮，顶栏「书签」可加书签。
          </p>
        ) : (
          <ul className="notes-list">
            {sorted.map((a) => {
              // PDF 标注以 page 定位（chapter_idx=0），显示「页码 X」；
              // 重排标注 page 恒为 null，行为不变。
              const chapterTitle =
                a.page != null
                  ? `页码 ${a.page}`
                  : (chapters[a.chapterIdx]?.title ?? `第 ${a.chapterIdx + 1} 节`);
              return (
                <li key={a.id} className="notes-item" onClick={() => onJump(a)}>
                  <span
                    className="notes-dot"
                    style={{ background: annotationColorHex(a.color) }}
                  />
                  <div className="notes-body">
                    <div className="notes-meta">
                      <span className="notes-kind">{KIND_LABEL[a.kind] ?? a.kind}</span>
                      <span className="notes-chapter">{chapterTitle}</span>
                    </div>
                    {a.kind !== "bookmark" && a.text ? (
                      <p className="notes-quote">“{a.text}”</p>
                    ) : null}
                    {a.noteBody ? <p className="notes-note">{a.noteBody}</p> : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost notes-delete"
                    aria-label="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(a.id);
                    }}
                  >
                    删除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}