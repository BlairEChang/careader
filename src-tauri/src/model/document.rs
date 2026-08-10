//! 统一文档模型（docs/architecture.md §5.1）。
//!
//! 所有 parser 把原始文件归一化为 `DocumentModel`，前端除 PDF 外共用一套
//! 重排渲染管线，不在前端做格式分支。

use serde::{Deserialize, Serialize};

/// 支持的书格式。序列化为小写字符串，与 `books.format` 列对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Epub,
    Mobi,
    #[serde(rename = "txt")]
    PlainText,
    #[serde(rename = "md")]
    Markdown,
    Pdf,
}

impl Format {
    /// 按扩展名探测格式。未知扩展返回 None（由调用方报 unsupported_format）。
    pub fn from_path(path: &std::path::Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "epub" => Some(Self::Epub),
            "mobi" | "azw" | "azw3" => Some(Self::Mobi),
            "txt" => Some(Self::PlainText),
            "md" | "markdown" => Some(Self::Markdown),
            "pdf" => Some(Self::Pdf),
            _ => None,
        }
    }
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Epub => write!(f, "epub"),
            Self::Mobi => write!(f, "mobi"),
            Self::PlainText => write!(f, "txt"),
            Self::Markdown => write!(f, "md"),
            Self::Pdf => write!(f, "pdf"),
        }
    }
}

/// 单个结构化块级元素（heading / paragraph / image），
/// 前端渲染为语义化标签，避免直接信任原始文本/HTML。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Element {
    Heading { text: String },
    Paragraph { text: String },
    Image { src: String },
}

/// 章节资源（图片等），经 Tauri asset protocol 暴露给前端。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resource {
    pub id: String,
    pub mime: String,
    /// 书库目录内的相对路径。
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chapter {
    /// EPUB 为章节原点路径，其他格式为索引字符串。
    pub id: String,
    pub title: String,
    pub content: Vec<Element>,
    pub resources: Vec<Resource>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentModel {
    pub format: Format,
    pub title: String,
    pub authors: Vec<String>,
    pub language: Option<String>,
    /// 正文切片。PDF 不产出章节正文，此字段为空。
    pub chapters: Vec<Chapter>,
    /// 封面资源 id（M3 起由后端提取落盘）。
    pub cover: Option<String>,
}