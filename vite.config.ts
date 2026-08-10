import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// pdf.js 的 cMap/标准字体/wasm 由 worker 以「baseUrl + 文件名」拼相对路径按需
// fetch（不能走 Vite 的哈希化资源），必须原文件名发布到静态根。M5 PDF 整页
// 管线（docs/architecture.md §6.4）依赖；目录会以 pdfjs/* 落进 public/。
const PDFJS_STATIC_ASSETS: Array<[string, string]> = [
  ["pdfjs-dist/cmaps", "pdfjs/cmaps"],
  ["pdfjs-dist/standard_fonts", "pdfjs/standard_fonts"],
  ["pdfjs-dist/wasm", "pdfjs/wasm"],
  ["pdfjs-dist/iccs", "pdfjs/iccs"],
];

function copyDirRecursive(src: string, dest: string): void {
  for (const name of readdirSync(src)) {
    const from = resolve(src, name);
    const to = resolve(dest, name);
    if (statSync(from).isDirectory()) {
      copyDirRecursive(from, to);
    } else {
      mkdirSync(dest, { recursive: true });
      copyFileSync(from, to);
    }
  }
}

function pdfjsStaticAssets(): Plugin {
  return {
    name: "careader:pdfjs-static-assets",
    buildStart() {
      for (const [srcRel, destRel] of PDFJS_STATIC_ASSETS) {
        copyDirRecursive(resolve("node_modules", srcRel), resolve("public", destRel));
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), pdfjsStaticAssets()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
