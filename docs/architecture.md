# careader 架构设计

本地阅读器（Tauri 2 + React 19 + TypeScript）。本文档定义项目的模块划分、数据模型、数据流与演进路线，作为骨架开发的蓝本。

## 1. 目标与范围

- **定位**：离线本地电子书阅读器，无账号、无云同步。
- **支持格式**：EPUB、MOBI、TXT、Markdown、PDF。
- **功能模块**：书架/书库管理、阅读进度记忆、书签与笔记、阅读偏好设置。

## 2. 技术选型与关键决策

| 决策点 | 方案 | 理由 |
|---|---|---|
| 解析层位置 | Rust 后端；PDF 例外走前端 | 强类型、离线、解析性能好；PDF 渲染库 Rust 生态不成熟 |
| EPUB 解析 | `zip` + `quick-xml` 自制（封装在 `parsers/epub.rs`） | `epub` crate 维护不稳定，自制可控 |
| MOBI 解析 | `mobi` crate | 覆盖 MOBI7 基本文本；KF8/AZW3 支持有限（见风险 §8） |
| PDF 渲染 | 前端 `pdf.js` + Tauri asset protocol 读取本地文件 | pdf.js 成熟；无需 Rust 渲染 SDK |
| TXT / Markdown | Rust 读文件 + 前端 `markdown-it` 渲染 | 零依赖，解析简单 |
| 元数据提取 | EPUB（opf）、MOBI（exth）、PDF 取首章文本 | 封面统一由后端提取为图片文件 |
| 持久化 | SQLite（`rusqlite` + 启动时迁移） | 单文件、无服务，进度/书签/笔记/偏好一体化 |
| 文件选择/FS | `tauri-plugin-dialog` + `tauri-plugin-fs` | 官方插件，走 capabilities 权限 |
| 前端状态 | zustand | 轻量、无服务端，三个 store 各自收敛职责 |
| IPC 错误 | Rust `thiserror` → 稳定错误结构 → 前端统一报错 Toast | 跨 IPC 错误可读、可追踪 |
| 构建 | pnpm + vite（沿用现有脚手架） | 无需变更 |

## 3. 分层架构

```
┌────────────────────────────────────────────────────────┐
│  React 前端 (src/)                                     │
│  书架视图 │ 阅读器(重排/整页) │ 笔记面板 │ 偏好设置      │
│  zustand store ←→ lib/api.ts（invoke 封装，类型安全）    │
├────────────────────────────────────────────────────────┤
│  Tauri IPC（commands）                                 │
│  library │ reading │ annotations │ settings            │
├────────────────────────────────────────────────────────┤
│  Rust 后端 (src-tauri/src/)                            │
│  parsers（统一 DocumentModel） + storage（SQLite + FS）  │
│  错误层 error.rs 贯穿所有 command                       │
└────────────────────────────────────────────────────────┘
```

原则：

- **前端无文件系统逻辑**：所有磁盘操作（导入、封面、书库拷贝）走后端 command。
- **前端无格式分支**：除 PDF 外，所有格式解析为统一 `DocumentModel` 后共用一套渲染管线；PDF 走独立的整页管线。
- **后端无 UI 逻辑**：Rust 只暴露命令与数据，不感知界面状态。

## 4. 目录结构

```
careader/
├── docs/
│   └── architecture.md            # 本文档
├── src/                           # 前端
│   ├── main.tsx
│   ├── App.tsx                    # 路由/布局：书架 ↔ 阅读器切换
│   ├── components/
│   │   ├── library/               # 书架视图
│   │   │   ├── LibraryView.tsx    # 书格网格 + 排序
│   │   │   ├── BookCard.tsx       # 封面/标题/进度角标
│   │   │   └── ImportDialog.tsx   # 多选导入（调用 dialog 插件）
│   │   ├── reader/
│   │   │   ├── ReaderView.tsx     # 阅读器主容器（双管线分发）
│   │   │   ├── reflowable/        # 可重排管线：EPUB/MOBI/TXT/MD
│   │   │   │   ├── ChapterView.tsx
│   │   │   │   └── paginate.ts    # 分页计算（CSS columns 测量）
│   │   │   ├── fixed/
│   │   │   │   └── PdfViewer.tsx  # 整页管线：pdf.js 封装
│   │   │   ├── TableOfContents.tsx
│   │   │   ├── AnnotationLayer.tsx# 高亮渲染 + 笔记气泡
│   │   │   ├── ProgressBar.tsx
│   │   │   └── ReaderSettings.tsx # 字体/字号/行距/主题面板
│   │   ├── notes/
│   │   │   └── NotesPanel.tsx     # 全书笔记/书签列表，可跳转
│   │   └── common/
│   │       ├── Toast.tsx          # 统一错误/成功提示
│   │       └── Spinner.tsx
│   ├── hooks/
│   │   ├── useBookContent.ts      # 拉取 DocumentModel + 资源 URL
│   │   ├── useProgress.ts         # 进度读取/防抖回写
│   │   └── useAnnotations.ts
│   ├── store/
│   │   ├── libraryStore.ts        # 书列表、导入状态
│   │   ├── readerStore.ts         # 当前书、章节、`翻页态`
│   │   └── settingsStore.ts       # 偏好（含持久化）
│   ├── lib/
│   │   ├── api.ts                 # invoke 封装 + 错误翻译
│   │   ├── types.ts               # 与 Rust 对齐的共享类型
│   │   └── theme.ts               # 主题变量生成
│   └── styles/
│       ├── global.css
│       └── reader.css             # 排版/分页/高亮样式
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs                 # Builder 装配：插件 + commands
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── library.rs         # import_books / list_books / remove_book
│   │   │   ├── reading.rs         # open_book / save_progress / get_toc
│   │   │   ├── annotations.rs     # CRUD 高亮、笔记、书签
│   │   │   └── settings.rs        # get_settings / set_settings
│   │   ├── parsers/
│   │   │   ├── mod.rs             # BookParser trait + register 表
│   │   │   ├── epub.rs            # zip 解包 + opf/ncx 解析 + 章节切片
│   │   │   ├── mobi.rs            # mobi crate 封装
│   │   │   ├── plaintext.rs       # txt（编码探测）/ md
│   │   │   └── pdf.rs             # 仅元数据 + 分页信息（渲染在端）
│   │   ├── model/
│   │   │   ├── mod.rs
│   │   │   ├── document.rs        # DocumentModel / Chapter / Resource
│   │   │   └── entities.rs        # Book / Progress / Annotation / Setting
│   │   ├── storage/
│   │   │   ├── mod.rs
│   │   │   ├── db.rs              # 连接、迁移（schema 见 §5）
│   │   │   └── fs.rs              # 书库目录、导入拷贝、封面落盘
│   │   └── error.rs               # AppError（thiserror）+ 序列化
│   └── capabilities/default.json  # 追加 dialog/fs/assets 权限
```

## 5. 数据模型

### 5.1 统一文档模型（Rust `model/document.rs`）

所有 parser 将原始文件归一化为：

```rust
struct DocumentModel {
    format: Format,            // Epub | Mobi | PlainText | Markdown | Pdf
    title: String,
    authors: Vec<String>,
    language: Option<String>,
    chapters: Vec<Chapter>,    // 正文切片（EPUB/MOBI/TXT/MD 才有正文）
    cover: Option<String>,     // 封面文件绝对路径（M3 起：解压落盘为
                               // {library}/{书名}/cover.{ext}；无封面为 None）
}

struct Chapter {
    id: String,                // EPUB 章节原点；其他为索引
    title: String,
    content: Vec<Element>,     // 结构化的块级元素（heading/para/image），
                               // 前端渲染为 HTML，避免直接信任原始 HTML
    resources: Vec<Resource>,  // 本章引用图片等
}

struct Resource {
    id: String,
    mime: String,
    path: String,              // 磁盘绝对路径（导入时从 zip 解压到 {library}/{书名}/，
                               // 经 asset protocol 暴露），前端 convertFileSrc 直接可用
}
```

trait 约定：

```rust
trait BookParser {
    fn parse(&self, file_path: &Path) -> Result<DocumentModel, AppError>;
}
```

- **TXT/MD 章节**：按空行/TXT 常见章节标记（`第X章`、`#` 标题）启发式切分，切成失败则全书为单章。
- **PDF 不产出章节正文**：`chapters` 为空，`PdfViewer` 直接用 asset URL 拉全文，进度以页码表达（见 §6.4）。

### 5.2 SQLite Schema（`storage/db.rs` 内迁移）

```sql
CREATE TABLE books (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    authors       TEXT NOT NULL DEFAULT '',      -- JSON 数组字符串
    format        TEXT NOT NULL,                 -- epub|mobi|txt|md|pdf
    file_path     TEXT NOT NULL UNIQUE,          -- 库内拷贝路径
    cover_path    TEXT,                          -- 封面图片路径（可空）
    added_at      INTEGER NOT NULL,              -- unix 秒
    last_opened_at INTEGER
);

CREATE TABLE progress (
    book_id       INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    chapter_idx   INTEGER NOT NULL DEFAULT 0,    -- 重排：章索引；PDF：页码
    char_offset   INTEGER NOT NULL DEFAULT 0,    -- 章内字符偏移（PDF 忽略）
    percent       REAL NOT NULL DEFAULT 0,       -- 0.0~1.0，书架角标用
    updated_at    INTEGER NOT NULL
);

CREATE TABLE annotations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                 -- highlight | note | bookmark
    chapter_idx   INTEGER NOT NULL,
    start         INTEGER NOT NULL,              -- 选中文本的字符起（重排）
    end           INTEGER NOT NULL,
    text          TEXT,                          -- 高亮原文快照
    note_body     TEXT,                          -- 笔记正文（highlight 可空）
    color         TEXT NOT NULL DEFAULT 'yellow',
    page          INTEGER,                       -- PDF 页码（重排置空）
    created_at    INTEGER NOT NULL
);
CREATE INDEX idx_annotations_book ON annotations(book_id, chapter_idx);

CREATE TABLE settings (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL                  -- JSON 编码，schema 在
                                                -- model/entities.rs 定义
);
```

settings 典型键：`fontSize`、`lineHeight`、`fontFamily`、`theme`（light/sepia/dark）、`paginationMode`。

## 6. 核心数据流

### 6.1 导入书籍

```
ImportDialog（dialog 插件多选）
  → invoke("import_books", paths)
  → library.rs：逐本 → storage/fs.rs 拷贝进书库目录（重名加后缀）
  → parsers 按扩展名选 parser → DocumentModel（EPUB 产生章节与资源引用）
  → EPUB：把正文引用的图片/封面从 zip 解压到 {library}/{书名}/（zip-slip 防护，
    单资源失败跳过不阻塞导入；封面失败 cover 置 None）
  → INSERT books（cover_path 取模型 cover）
  → 返回入库后的书列表 → libraryStore 更新书架
```

- 解析失败的书不中断批次：返回 `(ok_items, failed: Vec<(path, reason)>)`，前端 Toast 汇总。
  M6 起失败清单存 libraryStore，书架显示可关闭的摘要条并支持「重试」。
- 移除书籍时同时删除书文件与 `{library}/{书名}/` 资源目录。
- TXT 编码：优先 UTF-8，失败回退 GB18030 探测。

### 6.2 打开阅读（可重排管线）

```
BookCard 点击 → invoke("open_book", id)
  → 后端：查 books + progress → 返回 {model, progress}
  → useBookContent 组装 resources 的 asset URL（convertFileSrc）
  → ReaderView 按 format 分发到 reflowable（ChapterView + paginate）
  → 渲染后按 progress 定位并滚动
```

### 6.3 进度回写

- 翻页/滚动停止（300ms 防抖）→ `invoke("save_progress", …)` → UPSERT progress。
- PDF 管线在页码变化时回写（chapter_idx=页码, char_offset=0）。
- 回写失败静默重试一次，不打断阅读。
### 6.4 PDF 整页管线的特殊约定

- `open_book` 返回 `DocumentModel` 仅带 `title/authors/cover`（title 取文件名，无封面），
  前端用 `convertFileSrc(book.filePath)` 的 asset URL 交给 pdf.js 渲染。
- 实现的加载策略（双路径）：首选 `getDocument({ url })`（Tauri 2 asset protocol 支持
  Range/Content-Type）；若 WebView fetch 自定义 scheme 失败，自动回退
  `fetch(url) → arrayBuffer()` 后 `getDocument({ data })` 字节流加载。
- pdf.js v6：worker 经 `?url` 独立打包；cmaps/standard_fonts/wasm/iccs 由 vite 插件
  复制到 `public/pdfjs/`（`pdfjs-dist/**` 按原文件名静态输出）。cargo 侧仅需
  tauri 启用 `protocol-asset` feature，asset protocol scope 覆盖书库目录。
- TOC：前端 `getOutline()` 提取大纲（多级兜底：数组/Ref/字符串 dest），与后端无耦合；
  书签用 `annotations` 表（kind=bookmark，`page` 有值，chapter_idx=0）。
- 进度换算：`percent = page / pageCount`；回写时 `chapter_idx = 页码`、`char_offset = 0`。

### 6.5 高亮与笔记

```
AnnotationLayer 选区 → 计算 {chapter_idx, start, end, text}
  → invoke("create_annotation") → 落库 → 本地 store 乐观更新
  删除/编辑同理；NotesPanel 按书聚合展示，点击跳转到章节+偏移
```

### 6.6 偏好设置

settingsStore 读写内存 → 变更时防抖 `set_settings` → 后端按 key UPSERT；启动时一次性 `get_settings` 水合。主题仅存偏好值，CSS 变量由前端 `theme.ts` 生成。

## 7. 错误处理契约

Rust 侧统一：

```rust
#[derive(Debug, thiserror::Error, serde::Serialize)]
pub struct AppError { pub code: String, pub message: String }  // 中文消息由前端映射
```

`api.ts` 捕获 `invoke` 拒绝 → 按 `code` 映射文案 → Toast。约定 code 白名单：`parse_failed`、`unsupported_format`、`file_not_found`、`db`、`io`。

## 8. 格式支持矩阵与风险

| 格式 | 解析 | 渲染 | 元数据 | 风险 |
|---|---|---|---|---|
| EPUB 2/3 | 自制 zip+XML | 统一重排管线 | 完整 | 低；注意 EPUB3 无 ncx 只有 nav |
| TXT | 编码探测+章节启发式 | 统一重排管线 | 无（标题取文件名） | 低；章节切分可能误判，可后续人工分段 |
| Markdown | 读文件 | 统一重排（markdown-it） | 无 | 低 |
| MOBI | `mobi` crate | 统一重排管线 | 标题/作者 | 中：KF8/AZW3、图片提取不支持或受限；产出纯文本时表现降级 |
| PDF | 前端 pdf.js（后端只存文件） | 整页管线 | 标题/作者从 pdf.js 读取 | 中：扫描版无文本层，无重排能力；超大文件首屏慢 |

已知取舍（M1 不解决）：

- MOBI 图片/内嵌字体不提取，统一降级为纯文本。
- PDF 复制高亮需要文本层，扫描版仅支持书签（page 定位）。

## 9. 演进路线

| 阶段 | 内容 | 完成标志 | 状态 |
|---|---|---|---|
| M1 骨架 | 目录结构、db 迁移、错误层、library+plaintext commands、书架列表+导入 | 可导入 TXT/MD 并显示于书架 | ✅ 已完成 |
| M2 重排阅读 | reflowable 管线、progress 回写、设置面板 | EPUB/TXT/MD 可读、进度可续 | ✅ 已完成（CSS columns 分页 + scroll 双模式，300ms 防抖回写，主题/字号/行距/字体设置面板） |
| M3 EPUB/MOBI | epub parser、mobi parser、TOC、资源（图片）+封面 | EPUB 完整阅读体验；MOBI 文本可读 | ✅ 已完成（自制 zip+quick-xml 解析；资源/封面解压落盘；mobi crate 纯文本降级） |
| M4 高亮笔记 | annotations CRUD、AnnotationLayer、NotesPanel | 高亮/笔记/书签全流程 | ✅ 已完成（mark 包裹渲染、跨段单条记录、笔记气泡、乐观更新） |
| M5 PDF | asset 协议 + PdfViewer、页码进度、PDF 书签 | PDF 可读、进度可续 | ✅ 已完成（pdf.js v6 双路径加载、大纲、页码书签） |
| M6 打磨 | 主题、翻页动画、导入失败恢复、书架搜索排序 | 自测通过 | ✅ 已完成（全应用换肤、主动翻页动画、失败摘要+重试、搜索/三排序） |

M1–M6 已全部交付；每阶段产出保持可运行、可交付。变更记录见 §11。

## 10. 待确认开放项

以下开放项已随 M2–M6 定稿：

- ~~书架布局 / 翻页方式~~ → 网格布局；翻页方式由 `paginationMode` 设置提供
  `paged`（CSS columns 分页 + 翻页动画）与 `scroll`（连续滚动）两档，默认 paged。
- ~~是否引入路由库~~ → 不引入，手写双视图切换（书架 ↔ 阅读器）。
- ~~打包配置~~ → 窗口 960×640（min 700×500），图标沿用脚手架默认。

## 11. 实现状态与与蓝图偏差记录

实现期间对本文档蓝图作出的实际决策（供后续维护对齐）：

- **字段序列化**：`Book` / `Progress` / `Annotation` 均 `#[serde(rename_all = "camelCase")]`，
  与前端 `lib/types.ts` 的 camelCase 类型一一对应。
- **资源路径**：`Resource.path` / `Image.src` / `DocumentModel.cover` 均为磁盘绝对路径
  （§5.1 蓝图原为库内相对路径），asset protocol scope（`$APPDATA/library/**`）覆盖整个
  书库目录。EPUB 资源在导入期解压到 `{library}/{书名}/`，zip-slip 有防护。
- **命令清单（最终）**：`import_books` / `list_books` / `remove_book` / `open_book` /
  `get_toc` / `save_progress` / `list_progress` / `get_settings` / `set_settings` /
  `create_annotation`（含可选 `page`，PDF 书签用）/ `list_annotations` /
  `update_annotation` / `delete_annotation`。
- **依赖（最终）**：rusqlite 0.32（bundled）、zip 8.6（仅 deflate）、quick-xml 0.41、
  `mobi` 0.8、encoding_rs、tauri `protocol-asset` feature；前端 `pdfjs-dist` ^6.2。
- **解析行为**：`pdf.rs` 仅产出元数据模型（title=文件名，chapters 空，cover None），
  全部渲染走前端 pdf.js；MOBI 图片/内嵌字体不提取（§8 已知取舍成立）。
- **新增前端文件**（蓝图 §4 目录未列）：`src/lib/assets.ts`（convertFileSrc 封装）、
  `src/lib/annotations.ts`（选区⇄偏移换算 / mark 渲染）、`src/hooks/useAnnotations.ts`、
  `src/hooks/useProgress.ts`（防抖回写）、`src/hooks/useBookContent.ts`、
  `src/components/reader/fixed/PdfViewer.tsx`、`vite.config.ts`（pdf.js 静态资源插件）、
  `src/styles/reader.css`。

## 12. 待办（README 愿景中的未实现项）

以下为云端 README 功能愿景中尚未实现、留待后续迭代的需求（核心阅读链路已全部完成）：

- [ ] CBZ / 图片序列漫画阅读、HTML 格式阅读
- [ ] 书架分类、收藏
- [ ] 双页 / 全屏阅读模式
- [ ] 书内全文搜索（当前仅有书架级标题/作者搜索）
- [ ] 标注导出
- [ ] 打包分发实测（`pnpm tauri build` 产物各平台验证）