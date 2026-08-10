// 目录抽屉（docs/architecture.md §6.2）：章节列表 + 当前章高亮 + 点击跳章。

import type { Chapter } from "../../lib/types";

interface TocProps {
  open: boolean;
  title: string;
  chapters: Chapter[];
  currentIdx: number;
  onClose: () => void;
  /** 点击跳转到章节（父组件负责更新 currentChapterIdx）。 */
  onJump: (idx: number) => void;
}

export function TableOfContents({ open, title, chapters, currentIdx, onClose, onJump }: TocProps) {
  if (!open) return null;
  return (
    <div className="toc-overlay" onClick={onClose}>
      <aside className="toc-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="toc-header">
          <h3>{title}</h3>
          <button className="btn btn-ghost toc-close" onClick={onClose} aria-label="关闭目录">
            ×
          </button>
        </header>
        {chapters.length === 0 ? (
          <p className="toc-empty">（本书暂无章节正文）</p>
        ) : (
          <ol className="toc-list">
            {chapters.map((c, i) => (
              <li key={c.id}>
                <button
                  className={i === currentIdx ? "toc-item toc-item-active" : "toc-item"}
                  onClick={() => {
                    onJump(i);
                    onClose();
                  }}
                >
                  <span className="toc-index">{i + 1}</span>
                  {c.title || `第 ${i + 1} 节`}
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}