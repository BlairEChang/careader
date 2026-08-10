// 阅读偏好（docs/architecture.md §6.6）：内存读写 + 启动水合 + 防抖持久化。
// 主题仅存偏好值，CSS 变量实时由 theme.ts 应用到 <html>。

import { create } from "zustand";
import { api, describeError, toast } from "../lib/api";
import { applyTheme, type Theme } from "../lib/theme";
import type { PaginationMode } from "../lib/types";

export type FontFamily = "sans-serif" | "serif" | "monospace";
export type { Theme, PaginationMode };

export interface ReadingSettings {
  fontSize: number;
  lineHeight: number;
  fontFamily: FontFamily;
  theme: Theme;
  paginationMode: PaginationMode;
}

export const DEFAULT_SETTINGS: ReadingSettings = {
  fontSize: 18,
  lineHeight: 1.8,
  fontFamily: "serif",
  theme: "light",
  paginationMode: "paged",
};

const PERSIST_DEBOUNCE_MS = 500;
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 30;
const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.5;

export const FONT_FAMILIES: FontFamily[] = ["sans-serif", "serif", "monospace"];
const THEMES: Theme[] = ["light", "sepia", "dark"];
export const PAGINATION_MODES: PaginationMode[] = ["paged", "scroll"];

function asNumber(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

function asOneOf<T extends string>(v: unknown, list: readonly T[], def: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v)
    ? (v as T)
    : def;
}

/** 把后端 JSON 值合并进默认值：只接受类型与取值域都合法的字段。 */
export function normalizeSettings(raw: Record<string, unknown>): ReadingSettings {
  const fontSize = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, Math.round(asNumber(raw.fontSize, DEFAULT_SETTINGS.fontSize))),
  );
  const lineHeight = Math.min(
    LINE_HEIGHT_MAX,
    Math.max(LINE_HEIGHT_MIN, asNumber(raw.lineHeight, DEFAULT_SETTINGS.lineHeight)),
  );
  return {
    fontSize,
    lineHeight,
    fontFamily: asOneOf(raw.fontFamily, FONT_FAMILIES, DEFAULT_SETTINGS.fontFamily),
    theme: asOneOf(raw.theme, THEMES, DEFAULT_SETTINGS.theme),
    paginationMode: asOneOf(raw.paginationMode, PAGINATION_MODES, DEFAULT_SETTINGS.paginationMode),
  };
}

interface SettingsState {
  hydrated: boolean;
  settings: ReadingSettings;
  /** 启动水合：get_settings + 合并默认值 + 应用主题。 */
  hydrate: () => Promise<void>;
  setFontSize: (v: number) => void;
  setLineHeight: (v: number) => void;
  setFontFamily: (v: FontFamily) => void;
  setTheme: (v: Theme) => void;
  setPaginationMode: (v: PaginationMode) => void;
}

// 每个 key 独立的防抖定时器：多次连续变更只落库最后一次。
const persistTimers = new Map<string, number | null>();

function schedulePersist(key: string, value: unknown): void {
  const prev = persistTimers.get(key);
  if (prev !== null && prev !== undefined) window.clearTimeout(prev);
  const timer = window.setTimeout(() => {
    persistTimers.set(key, null);
    void api.setSettings(key, value).catch(() => {
      // 设置回写失败静默丢弃：不打断阅读，下次变更会再次尝试。
    });
  }, PERSIST_DEBOUNCE_MS);
  persistTimers.set(key, timer);
}

function patch(partial: Partial<ReadingSettings>): void {
  const next = { ...useSettingsStore.getState().settings, ...partial };
  useSettingsStore.setState({ settings: next });
  if (partial.theme) applyTheme(partial.theme);
  for (const [key, value] of Object.entries(partial)) {
    schedulePersist(key, value);
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  hydrated: false,
  settings: DEFAULT_SETTINGS,

  hydrate: async () => {
    if (useSettingsStore.getState().hydrated) return;
    try {
      const raw = await api.getSettings();
      const settings = normalizeSettings(raw);
      applyTheme(settings.theme);
      set({ settings, hydrated: true });
    } catch (e) {
      // 水合失败退回默认值；Toast 提示但阅读不受阻。
      applyTheme(DEFAULT_SETTINGS.theme);
      set({ hydrated: true });
      toast(describeError(e), "error");
    }
  },

  setFontSize: (v) =>
    patch({
      fontSize: Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(v))),
    }),
  setLineHeight: (v) =>
    patch({
      lineHeight: Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, Math.round(v * 10) / 10)),
    }),
  setFontFamily: (v) => patch({ fontFamily: v }),
  setTheme: (v) => patch({ theme: v }),
  setPaginationMode: (v) => patch({ paginationMode: v }),
}));

// 模块级自启动水合：settingsStore 首次被引用即拉取偏好（App 无需改动）。
void useSettingsStore.getState().hydrate();