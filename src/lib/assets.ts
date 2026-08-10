// 资源 URL 工具（docs/architecture.md §6.2）。
// 后端返回的封面/图片都是书库内的绝对路径，浏览器无法直接访问，
// 统一经 Tauri asset protocol（convertFileSrc）暴露。相对路径（如
// EPUB 内部资源，M3 起由后端转为绝对路径）保持原样返回。
//
// 回退（docs/android-port.md §4.2）：Android 部分真机对 app_data_dir 下文件走
// asset protocol 加载失败（tauri#14776），assetBlobUrl 经 IPC 读取字节生成 blob
// URL，仅作为 assetUrl 加载失败时的兜底。

import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";

const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

/** 把后端返回的绝对路径转为可加载的 asset URL；空串/相对路径原样返回。 */
export function assetUrl(path: string): string {
  if (!path) return path;
  if (ABS_PATH.test(path)) {
    return convertFileSrc(path);
  }
  return path;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

/** 按扩展名推断 blob 的 MIME（图片/PDF 分别用于 <img> 与 getDocument({ data })）。 */
function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export interface AssetBlobUrl {
  /** 可赋给 <img src>（或 getDocument({ url })）的 blob URL。 */
  url: string;
  /** 释放 blob URL：组件卸载 / 文档销毁时调用，避免泄漏。 */
  revoke: () => void;
}

/** 回退路径：经 IPC 读取书库文件字节 → blob URL。仅在 assetUrl 加载失败时使用，
 *  调用方负责在不再使用时 revoke()。 */
export async function assetBlobUrl(path: string): Promise<AssetBlobUrl> {
  const bytes = await api.readAssetBytes(path);
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(path) });
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}
