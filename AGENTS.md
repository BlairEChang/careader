# AGENTS.md

本地优先的 Tauri 2 桌面电子书阅读器：React 19 + TypeScript + Vite 前端，Rust 后端（SQLite + 文件系统）。文档与注释主要用中文——新写的注释/文档沿用中文。

## 开发命令

- `pnpm tauri dev` — 完整开发模式（Tauri 窗口 + Vite，端口 1420 strictPort）。**必须用 pnpm**；不要用 npm。
- `pnpm dev` — 只跑前端浏览器预览；无 Tauri API，依赖 invoke 的功能会失败。
- `pnpm build` — `tsc && vite build`，含类型检查。没有独立 lint/typecheck 脚本，也没有 eslint/prettier。
- `cargo test --manifest-path src-tauri/Cargo.toml` — Rust 单元测试（parser/storage 模块内的 `#[cfg(test)]`）。前端没有测试框架。
- `pnpm tauri build` — 生产构建，很慢；仅最后验证用。

## 架构规则（详见 docs/architecture.md，改行为需同步其 §11 偏差记录）

- **前端零文件系统逻辑**：所有磁盘操作（导入、拷贝、封面、删除）必须经 Rust Tauri command。新增后端能力 = 在 `src-tauri/src/commands/*.rs` 写 `#[tauri::command]` + 在 `lib.rs` `invoke_handler` 注册；前端只通过 `src/lib/api.ts` 调 `invoke`。
- **唯一例外是 PDF**：渲染在前端 pdf.js（`src/components/reader/fixed/PdfViewer.tsx`），后端 `parsers/pdf.rs` 只产元数据（title=文件名、chapters 空、cover None）。PDF 进度用 `chapter_idx=页码`、`char_offset=0`。
- **序列化契约**：Rust 实体 `#[serde(rename_all = "camelCase")]` 与 `src/lib/types.ts` 一一对应，两边改字段必须同步。
- **错误契约**：Rust 统一 `AppError { code, message }`；code 白名单 `parse_failed / unsupported_format / file_not_found / db / io` 由 `api.ts` 映射为前端文案。
- **资产协议**：书库在 `{app_data_dir}/library`（`storage/fs.rs`），scope 为 `$APPDATA/library/**`（tauri.conf.json `assetProtocol`）；前端用 `convertFileSrc`（`src/lib/assets.ts`）。EPUB 导入时把图片/封面解压到 `{library}/{书名}/`（有 zip-slip 防护）。
- **无前端格式分支**：除 PDF 外所有格式归一为 `DocumentModel`（`parsers/mod.rs` 的 `BookParser` trait 注册表），前端共用一套重排渲染管线；按格式加前端分支是错误的。
- **导入不中断**：`import_books` 返回 `(ok, failed)`，单书解析失败不阻塞批次；TXT 编码优先 UTF-8，失败回退 GB18030。
- **SQLite schema** 迁移在 `storage/db.rs`，启动时执行；书删除会级联清理 progress/annotations 及书文件、资源目录。

## 环境与生成物

- `public/pdfjs/` 由 vite.config.ts 的插件在 buildStart 时从 `node_modules/pdfjs-dist` 复制生成（cMap/标准字体/wasm/iccs），已在 .gitignore——不要手改、不要提交；pdf.js worker 加载靠它。
- vite.config.ts 用 `process.env.TAURI_DEV_HOST` 支持远程 HMR；`node:fs` 在配置里直接做复制，无第三方依赖。
- 权限在 `src-tauri/capabilities/default.json`：目前只有 `core:default` + `dialog:default`。新增插件/命令权限要在这里加，否则运行时被拒。
- 无 CI、无 pre-commit 钩子。

## 目录速览

- `src/components/reader/reflowable/` — EPUB/MOBI/TXT/MD 共用重排管线（CSS columns 分页 + scroll 双模式，`paginationMode` 设置）。
- `src/store/` — zustand：`libraryStore` / `readerStore` / `settingsStore`；进度防抖 300ms 回写（`src/hooks/useProgress.ts`）。
- `src-tauri/src/parsers/` — 自制 zip+quick-xml 的 EPUB 解析；MOBI 用 `mobi` crate（纯文本降级，不提取图片/字体）。
- 建议先读 `docs/architecture.md`：含命令清单（§11）、数据模型（§5）、PDF 约定（§6.4）。