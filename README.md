# Careader

<div align="center">

本地优先的多格式阅读器

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#)

</div>

**Careader** 是一款基于 [Tauri](https://tauri.app) 的跨平台桌面阅读器。它把"读取本地文件"和"本地书架管理"合二为一：不依赖云端、不收集数据，完全离线可用，专注于安静舒适的阅读体验。

## 功能特性

> 项目目前处于早期开发阶段（脚手架），以下为产品愿景。标注为「规划中」的功能尚未实现。

| 特性 | 状态 |
|---|---|
| 丰富的格式支持（EPUB / PDF / TXT / Markdown / CBZ 漫画 / HTML） | 规划中 |
| 本地书架管理：导入、分类、收藏 | 规划中 |
| 阅读进度自动记忆与续读 | 规划中 |
| 目录 (TOC) 导航与书签 | 规划中 |
| 多种阅读模式：滚动 / 双页 / 全屏 | 规划中 |
| 主题与字体自定义 | 规划中 |
| 全文搜索与标注导出 | 规划中 |
| 完全离线、本地文件优先，隐私友好 | 规划中 |

## 规划清单

**已实现**

- [x] Tauri 2 + React 桌面应用脚手架

**规划中**

- [ ] EPUB 解析与渲染
- [ ] 纯文本 / Markdown 阅读
- [ ] PDF 阅读
- [ ] 漫画 (CBZ / 图片序列) 阅读
- [ ] 本地书架：导入、分类、收藏
- [ ] 阅读进度记忆与续读
- [ ] 目录导航、书签、划线标注
- [ ] 阅读模式（滚动 / 双页 / 全屏）
- [ ] 主题与字体设置
- [ ] 全文搜索

## 路线图

- **Phase 1 — 骨架搭建**（当前阶段）：桌面窗口、文件打开与选择、前端框架搭建
- **Phase 2 — 核心阅读**：文本类格式（TXT / Markdown / EPUB）的解析与渲染、阅读模式
- **Phase 3 — 书架与进度**：本地书架管理、阅读进度记忆、搜索
- **Phase 4 — 打磨发布**：主题定制、性能优化、打包分发与文档完善

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | [Tauri 2](https://tauri.app)（Rust） |
| 前端 | [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org) |
| 构建工具 | [Vite](https://vite.dev) |
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

> 完整命令参考：[package.json](package.json)。

## 架构结构

```
careader/
├── src/              # React 前端
│   ├── App.tsx       # 主界面
│   └── main.tsx      # 入口
├── src-tauri/        # Rust 后端（Tauri 应用壳）
│   ├── src/lib.rs    # 后端逻辑与 Tauri 命令（文件系统访问等）
│   └── tauri.conf.json
├── index.html        # Vite 入口 HTML
├── vite.config.ts    # Vite 配置
└── package.json
```

设计原则：**前端只管渲染与交互，所有本地文件读写、书库存储等系统能力由 Rust 后端通过 Tauri command 暴露**，保证安全与性能。

## 参与贡献

欢迎任何形式的贡献！

- 提交 [Issue](https://github.com/BlairEChang/careader/issues) 报告 Bug 或建议新功能
- Fork 并提交 Pull Request 完善代码与文档

## 许可证

[MIT](LICENSE) © 2026 [BlairEChang](https://github.com/BlairEChang)
