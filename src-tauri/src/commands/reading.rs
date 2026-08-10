//! 阅读命令（docs/architecture.md §6.2 / §6.3）。
//!
//! `open_book` 返回统一文档模型 + 续读进度；重排管线据此定位渲染。
//! PDF 的模型无正文，M5 由前端 pdf.js 直接读取文件。

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::model::document::DocumentModel;
use crate::model::entities::Progress;
use crate::parsers;
use crate::storage::db;
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct OpenBook {
    pub model: DocumentModel,
    pub progress: Option<Progress>,
}

#[derive(Debug, Serialize)]
pub struct TocEntry {
    pub id: String,
    pub title: String,
}

/// 打开一本书：解析文件 + 取出续读进度 + 记 last_opened_at。
#[tauri::command]
pub fn open_book(state: State<'_, AppState>, id: i64) -> Result<OpenBook, AppError> {
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    let book = db::get_book(&conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("book #{id}")))?;
    db::touch_book(&conn, id)?;

    let file = Path::new(&book.file_path);
    if !file.exists() {
        return Err(AppError::FileNotFound(book.file_path.clone()));
    }
    let model = parsers::for_format(book.format).parse(file)?;
    let progress = db::get_progress(&conn, id)?;
    Ok(OpenBook { model, progress })
}

/// 章节目录（重排管线）。PDF 无正文，返回空列表（TOC 由前端 pdf.js 提取）。
#[tauri::command]
pub fn get_toc(state: State<'_, AppState>, id: i64) -> Result<Vec<TocEntry>, AppError> {
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    let book = db::get_book(&conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("book #{id}")))?;
    drop(conn);
    let file = Path::new(&book.file_path);
    if !file.exists() {
        return Err(AppError::FileNotFound(book.file_path.clone()));
    }
    let model = parsers::for_format(book.format).parse(file)?;
    Ok(model
        .chapters
        .into_iter()
        .map(|c| TocEntry { id: c.id, title: c.title })
        .collect())
}

/// 全部书的进度（书架角标用，见 docs/architecture.md §6.3）。
#[tauri::command]
pub fn list_progress(state: State<'_, AppState>) -> Result<Vec<Progress>, AppError> {
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    db::list_progress(&conn)
}

/// 进度回写（UPSERT）。翻页/滚动停止后前端防抖调用。
#[tauri::command]
pub fn save_progress(
    state: State<'_, AppState>,
    book_id: i64,
    chapter_idx: i64,
    char_offset: i64,
    percent: f64,
) -> Result<(), AppError> {
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    db::upsert_progress(&conn, book_id, chapter_idx, char_offset, percent)
}