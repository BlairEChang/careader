// 阅读设置面板（docs/architecture.md §6.6）：字号/行距/字体族/主题/翻页模式。
// 面板只读写 settingsStore，持久化由 store 内部 500ms 防抖完成。

import {
  FONT_FAMILIES,
  PAGINATION_MODES,
  useSettingsStore,
  type FontFamily,
} from "../../store/settingsStore";
import { THEME_LABELS, THEME_ORDER } from "../../lib/theme";

interface ReaderSettingsProps {
  open: boolean;
  onClose: () => void;
}

const FONT_LABELS: Record<FontFamily, string> = {
  "sans-serif": "无衬线",
  serif: "衬线",
  monospace: "等宽",
};

const MODE_LABELS = { paged: "分页", scroll: "滚动" } as const;

function SliderRow({
  label,
  value,
  display,
  onStep,
}: {
  label: string;
  value: string;
  display: string;
  onStep: (dir: 1 | -1) => void;
}) {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <div className="settings-stepper">
        <button className="btn settings-step" onClick={() => onStep(-1)} aria-label={`减小${label}`}>
          −
        </button>
        <span className="settings-value">{display !== "" ? display : value}</span>
        <button className="btn settings-step" onClick={() => onStep(1)} aria-label={`增大${label}`}>
          ＋
        </button>
      </div>
    </div>
  );
}

function SegmentedRow<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <div className="settings-segment">
        {options.map((opt) => (
          <button
            key={opt}
            className={opt === value ? "btn settings-segbtn settings-segbtn-active" : "btn settings-segbtn"}
            onClick={() => onChange(opt)}
          >
            {labels[opt]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReaderSettings({ open, onClose }: ReaderSettingsProps) {
  const settings = useSettingsStore((s) => s.settings);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setLineHeight = useSettingsStore((s) => s.setLineHeight);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setPaginationMode = useSettingsStore((s) => s.setPaginationMode);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h3>阅读设置</h3>
          <button className="btn btn-ghost settings-close" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </header>

        <SliderRow
          label="字号"
          value={`${settings.fontSize}`}
          display={`${settings.fontSize}px`}
          onStep={(dir) => setFontSize(settings.fontSize + dir)}
        />
        <SliderRow
          label="行距"
          value={`${settings.lineHeight}`}
          display={`${settings.lineHeight}`}
          onStep={(dir) => setLineHeight(settings.lineHeight + dir * 0.1)}
        />
        <SegmentedRow
          label="字体"
          options={FONT_FAMILIES}
          labels={FONT_LABELS}
          value={settings.fontFamily}
          onChange={setFontFamily}
        />
        <SegmentedRow
          label="主题"
          options={THEME_ORDER}
          labels={THEME_LABELS}
          value={settings.theme}
          onChange={setTheme}
        />
        <SegmentedRow
          label="翻页"
          options={PAGINATION_MODES}
          labels={MODE_LABELS}
          value={settings.paginationMode}
          onChange={setPaginationMode}
        />
      </div>
    </div>
  );
}