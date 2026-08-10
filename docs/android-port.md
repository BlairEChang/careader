# Careader Android 移植评估报告

> 状态：评估完成，待实施。本报告记录移植可行性、阻塞点、风险与实施路线。

## 1. 结论

**可行。** 技术栈具备天然移植条件：Tauri 2 原生支持 Android（WebView = Android System WebView），`src-tauri/src/lib.rs` 已存在 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 移动端入口。核心阅读链路（解析/存储/渲染）90% 平台无关，但存在 **1 个必须改造的阻塞点**（文件导入）和 **1 个真机风险**（asset protocol），预计需 4–6 人日完成可用版移植（不含 UI 打磨）。

## 2. 已具备的移植条件

| 条件 | 证据 |
|---|---|
| 移动端入口点 | `lib.rs` `#[cfg_attr(mobile, tauri::mobile_entry_point)]` |
| Rust 解析层纯跨平台 | epub/mobi/txt/md 全在 `src-tauri/src/parsers/`，无桌面 API 依赖 |
| 数据库跨平台 | rusqlite `bundled` 静态编译，Android 只需 NDK |
| 渲染跨平台 | pdf.js + CSS columns 分页均基于 WebView（Chromium），移动端可直接运行 |
| IPC 命令层无平台差异 | 全部走 `invoke`，前端 `lib/api.ts` 封装无需改 |
| 无平台敏感插件 | 仅依赖 `plugin-dialog`（其移动端行为不同，见 §4.1） |

## 3. 模块移植评估

### 3.1 直接可用（零改造）

- **解析器**：EPUB zip+XML、MOBI、TXT/MD 编码探测 —— 纯 Rust。
- **SQLite 持久化**：`storage/db.rs` schema 与迁移逻辑不变。
- **全部 13 个 command**：函数签名不变，仅 `import_books` 的输入形态需要适配（见 §4.1）。
- **前端状态层**：zustand 三个 store 与 `lib/types.ts`、`lib/api.ts`。
- **重排阅读管线**：`paginate.ts` 基于视口尺寸测量，在手机分辨率下天然工作。
- **PDF 管线**：pdf.js 可在 Android WebView 运行，但依赖 asset 加载路径（见 §4.2）。

### 3.2 需要适配改造

- **文件导入链路**（阻塞点，详见 §4.1）。
- **UI 触屏适配**（工作量大项）：
  - 注释/笔记的气泡与 hover 交互 → 改为 touch 长按/点按；
  - 阅读器翻页 → 桌面箭头键/按钮 + 移动端点击左右区域或滑动；
  - 书架网格、NotesPanel 侧栏、设置面板 → 响应式断点；
  - 系统返回键处理（Android back 手势 → 退出阅读器）。
- **构建配置**：`tauri.conf.json` 补 Android 图标、`minSdkVersion`（Tauri 2 要求 ≥24）；`bundle.targets` 增加 android；capabilities 中 `windows: ["main"]` 在移动端默认 label 一致，无需改。

### 3.3 需要专项验证

- **asset protocol / `convertFileSrc`** 真机行为（见 §4.2）。
- **大 PDF 性能**：手机 WebView 渲染百页 PDF 的首屏与滚动性能需实机测试。

## 4. 阻塞点与风险详解

### 4.1 【阻塞点】文件导入 —— Android 返回 content:// URI

**现状**：`ImportDialog.tsx` `dialog.open()` 返回路径 → `import_books` 用 `std::fs::copy()` 拷入书库（`commands/library.rs`）。

**问题**：Tauri 官方明确，Android 上 `dialog.open()` 返回 `content://` URI（由 SAF 内容提供者授予），**不是文件系统路径**，`std::fs` 无法读取，导入必然失败。这是整个移植中唯一必须重写的链路。

**已定方案（Rust ContentResolver 命令）**：新增 Android 专属 command，用 `ContentResolver.openInputStream(contentUri)` 流式把源文件拷入书库目录，随后复用现有解析流程。

- Rust 侧需引入 `tauri` 移动端扩展能力（`android_activity`/`jni`）或使用第三方 `tauri-plugin-android-fs`（其 `open_file(contentUri)` 可直接返回 `std::fs::File`）。
- 桌面端 `import_books` 保持现状，按 `#[cfg(mobile)]` / 运行时平台分支分流。
- 优点：PDF/大文件无内存压力，导入体验与桌面一致。

### 4.2 【风险】asset protocol 真机兼容性

`convertFileSrc` 生成的 URL 在 Android 为 `http://<identifier>.localhost/...`。已确认存在开放 bug（tauri#14776）：**`app_data_dir` 下文件在模拟器正常、部分真机加载失败**。当前 `csp: null` 不受 CSP 影响，但需：

1. 真机验证书架封面、EPUB 图片、PDF 全文加载；
2. 若失败，回退方案：新增 `read_asset_bytes` 命令流式返回字节 → 前端 `Blob`/`data:` URL（封面/图片可用，PDF 用 `getDocument({ data })` 已有该路径，见 `PdfViewer.tsx` 双路径设计）。

### 4.3 【低风险项】

- **构建环境**：Android SDK/NDK/JDK + Rust `aarch64-linux-android` / `armv7-linux-androideabi` 目标，一次性环境成本。
- **MOBI crate**：纯 Rust 无平台依赖，行为与桌面一致。
- **版本发布**：APK 签名、`AndroidManifest` 的 INTERNET 权限（asset 协议 localhost 需要），Tauri 脚手架默认处理。

## 5. 工作量估算（不含 UI 打磨）

| 阶段 | 内容 | 估算 |
|---|---|---|
| M0 | 环境搭建 + `pnpm tauri android init` + 空壳 APK 跑通 | 0.5–1 人日 |
| M1 | ContentResolver 导入命令 + 前后端分流改造 | 1–2 人日 |
| M2 | asset protocol 真机验证 + 字节流回退 | 0.5–1 人日 |
| M3 | 触屏 UI 适配（翻页/标注/返回键/响应式） | 2–3 人日 |
| M4 | 真机全链路回归 + 打包 | 0.5–1 人日 |

## 6. 推荐实施路线

1. **M0** 搭建移动工程，确认构建链路。
2. **M1** 打通导入（唯一阻塞点），先验证 TXT/EPUB 在真机可读可续读。
3. **M2** 验证 PDF/图片 asset 加载，决定是否需要回退路径。
4. **M3** 触屏适配（此时已有可运行版本，边适配边验收）。
5. **M4** 回归 + 签名打包。

## 7. 关键决策记录

- **导入方案**：采用 Rust ContentResolver 命令（桌面端 `import_books` 保持不变）。
- **目标范围**：先完成评估报告落盘，尚未开始实施。
