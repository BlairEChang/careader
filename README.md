# Careader

<div align="center">

本地优先的多格式阅读器

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#)

</div>

**Careader** 是一款基于 [Tauri](https://tauri.app) 的跨平台桌面阅读器。它把"读取本地文件"和"本地书架管理"合二为一：不依赖云端、不收集数据，完全离线可用，专注于安静舒适的阅读体验。

## 功能特性

| 特性 | 状态 |
|---|---|
| 格式支持（EPUB / MOBI / TXT / Markdown / PDF） | ✅ 已实现 |
| 本地书架管理：导入、移除、搜索、排序 | ✅ 已实现（分类、收藏规划中） |
| 阅读进度自动记忆与续读 | ✅ 已实现 |
| 目录 (TOC) 导航、书签、划线标注与笔记 | ✅ 已实现（含 PDF 页码书签） |
| 阅读模式：分页 / 滚动、翻页动画 | ✅ 已实现（双页、全屏规划中） |
| 主题（浅色 / 米色 / 深色）与字体自定义 | ✅ 已实现 |
| 导入失败恢复（失败清单 + 重试） | ✅ 已实现 |
| 漫画 (CBZ / 图片序列) / HTML 格式 | 规划中 |
| 全文搜索与标注导出 | 规划中 |
| 完全离线、本地文件优先，隐私友好 | ✅ 符合设计 |

## 规划清单

**已实现**

- [x] Tauri 2 + React 桌面应用脚手架
- [x] EPUB / MOBI / TXT / Markdown / PDF 解析与渲染
- [x] 本地书架：导入、移除、搜索、排序
- [x] 阅读进度记忆与续读
- [x] 目录导航、书签、划线标注与笔记
- [x] 阅读模式（分页 / 滚动）与翻页动画
- [x] 主题（浅色 / 米色 / 深色）与字体设置

**规划中**

- [ ] 漫画 (CBZ / 图片序列) 阅读
- [ ] HTML 格式阅读
- [ ] 书架分类、收藏
- [ ] 双页 / 全屏阅读模式
- [ ] 全文搜索
- [ ] 标注导出

## 路线图

- **Phase 1 — 骨架搭建** ✅：桌面窗口、文件打开与选择、前端框架搭建
- **Phase 2 — 核心阅读** ✅：文本类格式（TXT / Markdown / EPUB / MOBI）的解析与渲染、阅读模式
- **Phase 3 — 书架与进度** ◑：本地书架管理、阅读进度记忆已完成；全文搜索规划中
- **Phase 4 — 打磨发布** ◑：主题定制、性能优化已完成；双页 / 全屏、标注导出、打包分发与文档完善待推进

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | [Tauri 2](https://tauri.app)（Rust，SQLite 持久化） |
| 前端 | [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org) |
| 构建工具 | [Vite](https://vite.dev) |
| PDF 渲染 | [pdf.js](https://mozilla.github.io/pdf.js/) |
| 包管理 | [pnpm](https://pnpm.io) |

## 系统要求

请先安装 Tauri 的开发前置依赖：

- **Node.js**（建议 ≥ 20）与 [pnpm](https://pnpm.io/installation)
- **Rust**（通过 [rustup](https://rustup.rs) 安装，建议使用 stable 工具链）
- 各平台的系统依赖，参见 [Tauri 官方文档 - Prerequisites](https://v2.tauri.app/start/prerequisites/)
  - Linux 需要 `webkit2gtk-4.1`、`libappindicator` 等系统包
  - Windows 需要 Visual Studio C++ Build Tools 与 WebView2
  - macOS 需要 Xcode Command Line Tools

## 开发指南

```bash
# 安装依赖
pnpm install

# 启动开发模式（Tauri 窗口 + Vite 热更新）
pnpm tauri dev

# 只启动前端（浏览器预览）
pnpm dev

# 构建生产版本（Rust 后端 + 前端打包）
pnpm tauri build
```

测试与检查：

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 解析/数据库/命令测试
pnpm exec tsc --noEmit                            # 前端类型检查
pnpm build                                        # 前端构建
```

> 完整命令参考：[package.json](package.json)。

## 架构结构

```
careader/
├── docs/architecture.md  # 架构设计（模块划分、数据模型、M1–M6 状态与偏差记录）
├── src/                  # React 前端
│   ├── App.tsx           # 主界面（书架 ↔ 阅读器）
│   ├── components/       # library / reader / notes / common
│   ├── hooks/            # 进度回写、内容组装、标注
│   ├── store/            # zustand：library / reader / settings
│   └── lib/              # api 封装、类型、主题、标注换算
├── src-tauri/            # Rust 后端
│   ├── src/commands/     # library / reading / annotations / settings
│   ├── src/parsers/      # epub / mobi / plaintext / pdf → 统一 DocumentModel
│   ├── src/storage/      # SQLite + 书库文件系统
│   └── tauri.conf.json
├── index.html            # Vite 入口 HTML
├── vite.config.ts        # Vite 配置（含 pdf.js 静态资源插件）
└── package.json
```

设计原则：**前端只管渲染与交互，所有本地文件读写、书库存储等系统能力由 Rust 后端通过 Tauri command 暴露**，保证安全与性能。

## 参与贡献

欢迎任何形式的贡献！

- 提交 [Issue](https://github.com/BlairEChang/careader/issues) 报告 Bug 或建议新功能
- Fork 并提交 Pull Request 完善代码与文档

## 许可证

[MIT](LICENSE) © 2026 [BlairEChang](https://github.com/BlairEChang)
