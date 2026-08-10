// 资源 URL 工具（docs/architecture.md §6.2）。
// 后端返回的封面/图片都是书库内的绝对路径，浏览器无法直接访问，
// 统一经 Tauri asset protocol（convertFileSrc）暴露。相对路径（如
// EPUB 内部资源，M3 起由后端转为绝对路径）保持原样返回。

import { convertFileSrc } from "@tauri-apps/api/core";

const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

/** 把后端返回的绝对路径转为可加载的 asset URL；空串/相对路径原样返回。 */
export function assetUrl(path: string): string {
  if (!path) return path;
  if (ABS_PATH.test(path)) {
    return convertFileSrc(path);
  }
  return path;
}