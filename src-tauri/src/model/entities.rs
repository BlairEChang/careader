//! 持久化实体，与 SQLite schema（docs/architecture.md §5.2）一一对应。

use serde::{Deserialize, Serialize};

use super::document::Format;

/// 序列化统一 camelCase，与前端 `lib/types.ts` 对齐（Annotation 同约定）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: i64,
    pub title: String,
    /// JSON 数组字符串反序列化后的作者列表。
    pub authors: Vec<String>,
    pub format: Format,
    /// 书库目录内的拷贝路径。
    pub file_path: String,
    /// 封面图片路径（M3 起有值）。
    pub cover_path: Option<String>,
    /// unix 秒。
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub book_id: i64,
    /// 重排：章索引；PDF：页码。
    pub chapter_idx: i64,
    /// 章内字符偏移（PDF 忽略）。
    pub char_offset: i64,
    /// 0.0~1.0，书架角标用。
    pub percent: f64,
    pub updated_at: i64,
}

/// 标注（高亮/笔记/书签），对应 annotations 表。
/// 序列化用 camelCase：跨 IPC 字段与前端 `lib/types.ts` 的 Annotation 对齐。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: i64,
    pub book_id: i64,
    /// highlight | note | bookmark
    pub kind: String,
    pub chapter_idx: i64,
    /// 选中文本字符起（重排）。
    pub start: i64,
    pub end: i64,
    /// 高亮原文快照。
    pub text: Option<String>,
    /// 笔记正文（highlight 可空）。
    pub note_body: Option<String>,
    pub color: String,
    /// PDF 页码（重排置空，M5 使用）。
    pub page: Option<i64>,
    pub created_at: i64,
}

/// 新建标注入参：id 与 created_at 由存储层生成。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAnnotation {
    pub book_id: i64,
    pub kind: String,
    pub chapter_idx: i64,
    pub start: i64,
    pub end: i64,
    /// 高亮原文快照（书签为 None）。
    pub text: Option<String>,
    pub color: String,
    /// PDF 页码；重排书恒为 None。
    pub page: Option<i64>,
}