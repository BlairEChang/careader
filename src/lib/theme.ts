// 全局主题（docs/architecture.md §6.6）。
// 主题仅存偏好值，CSS 变量由本模块生成：applyTheme 把变量写入 <html> 并标注
// data-theme。--reader-* 供阅读器（reader.css 消费）；--bg/--text 等全局变量
// 供书架/Toast 等书架侧界面（global.css 消费）——两套变量同一主题源，保证
// 整个应用换肤一致。

export type Theme = "light" | "sepia" | "dark";

export interface ReaderThemeVars {
  "--reader-bg": string;
  "--reader-fg": string;
  "--reader-fg-muted": string;
  "--reader-border": string;
  "--reader-elevated": string;
  "--reader-accent": string;
  "--reader-accent-strong": string;
  "--reader-shadow": string;
}

export interface AppThemeVars {
  "--bg": string;
  "--bg-elevated": string;
  "--border": string;
  "--text": string;
  "--text-muted": string;
  "--primary": string;
  "--primary-strong": string;
  "--danger": string;
  "--shadow": string;
  "--shadow-hover": string;
  "--hover": string;
  "--cover-bg": string;
}

export interface ThemeVars extends ReaderThemeVars, AppThemeVars {}

export const THEMES: Record<Theme, ThemeVars> = {
  light: {
    "--reader-bg": "#f7f6f3",
    "--reader-fg": "#2b2926",
    "--reader-fg-muted": "#8a857c",
    "--reader-border": "#e4e1da",
    "--reader-elevated": "#ffffff",
    "--reader-accent": "#c2643a",
    "--reader-accent-strong": "#a8502c",
    "--reader-shadow": "0 2px 10px rgba(0, 0, 0, 0.08)",
    "--bg": "#f7f6f3",
    "--bg-elevated": "#ffffff",
    "--border": "#e4e1da",
    "--text": "#2b2926",
    "--text-muted": "#8a857c",
    "--primary": "#c2643a",
    "--primary-strong": "#a8502c",
    "--danger": "#c0392b",
    "--shadow": "0 1px 3px rgba(0, 0, 0, 0.08)",
    "--shadow-hover": "0 4px 10px rgba(0, 0, 0, 0.12)",
    "--hover": "rgba(0, 0, 0, 0.05)",
    "--cover-bg": "#ece8e0",
  },
  sepia: {
    "--reader-bg": "#f4ecd8",
    "--reader-fg": "#5b4636",
    "--reader-fg-muted": "#9b8774",
    "--reader-border": "#e0d2b4",
    "--reader-elevated": "#fbf5e6",
    "--reader-accent": "#a05a2c",
    "--reader-accent-strong": "#8a4a22",
    "--reader-shadow": "0 2px 10px rgba(91, 70, 54, 0.12)",
    "--bg": "#f4ecd8",
    "--bg-elevated": "#fbf5e6",
    "--border": "#e0d2b4",
    "--text": "#5b4636",
    "--text-muted": "#9b8774",
    "--primary": "#a05a2c",
    "--primary-strong": "#8a4a22",
    "--danger": "#b3422a",
    "--shadow": "0 1px 3px rgba(91, 70, 54, 0.14)",
    "--shadow-hover": "0 4px 10px rgba(91, 70, 54, 0.22)",
    "--hover": "rgba(91, 70, 54, 0.06)",
    "--cover-bg": "#e8ddc4",
  },
  dark: {
    "--reader-bg": "#1d1f24",
    "--reader-fg": "#d8d5cf",
    "--reader-fg-muted": "#8b8a84",
    "--reader-border": "#33363d",
    "--reader-elevated": "#262a31",
    "--reader-accent": "#d98e5f",
    "--reader-accent-strong": "#e6a97e",
    "--reader-shadow": "0 2px 10px rgba(0, 0, 0, 0.35)",
    "--bg": "#1d1f24",
    "--bg-elevated": "#262a31",
    "--border": "#33363d",
    "--text": "#d8d5cf",
    "--text-muted": "#8b8a84",
    "--primary": "#d98e5f",
    "--primary-strong": "#e6a97e",
    "--danger": "#e0574a",
    "--shadow": "0 1px 3px rgba(0, 0, 0, 0.4)",
    "--shadow-hover": "0 4px 12px rgba(0, 0, 0, 0.55)",
    "--hover": "rgba(255, 255, 255, 0.07)",
    "--cover-bg": "#2b2e35",
  },
};

export const THEME_ORDER: Theme[] = ["light", "sepia", "dark"];

export const THEME_LABELS: Record<Theme, string> = {
  light: "明亮",
  sepia: "羊皮纸",
  dark: "夜间",
};

/** 取某主题的 CSS 变量表（{key, value}[]），供内存态/测试使用。 */
export function themeCssVars(theme: Theme): Array<[string, string]> {
  return Object.entries(THEMES[theme]);
}

/** 把主题变量写入 <html>（data-theme + CSS 变量），切换即时生效。 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  for (const [key, value] of Object.entries(THEMES[theme])) {
    root.style.setProperty(key, value);
  }
}