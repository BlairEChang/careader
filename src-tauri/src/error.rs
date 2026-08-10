//! 全局错误层：所有 command 的返回错误统一为 `AppError`。
//!
//! 契约（见 docs/architecture.md §7）：
//! - 错误以稳定结构 `{ code, message }` 序列化跨 IPC 传给前端；
//! - code 白名单由前端 `lib/api.ts` 映射为中文文案，message 保留技术细节。

use std::io;

use serde::ser::{Serialize, SerializeStruct, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("parse failed: {0}")]
    ParseFailed(String),
    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),
    #[error("file not found: {0}")]
    FileNotFound(String),
    #[error("record not found: {0}")]
    NotFound(String),
    #[error("internal error: {0}")]
    Internal(String),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ParseFailed(_) => "parse_failed",
            Self::UnsupportedFormat(_) => "unsupported_format",
            Self::FileNotFound(_) => "file_not_found",
            Self::NotFound(_) => "not_found",
            Self::Internal(_) => "internal",
            Self::Db(_) => "db",
            Self::Io(_) => "io",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", &self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}