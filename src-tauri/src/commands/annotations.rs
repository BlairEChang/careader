//! 高亮/笔记/书签 CRUD（docs/architecture.md §6.5）。
//!
//! 定位字段语义：重排书存 `chapter_idx` + 章内字符起止（UTF-16 码元索引，
//! 由前端 paginate/annotations 工具计算）；PDF 书签存 `page` 页码
//! （chapter_idx=0、start=end=0、text=null，见 §6.4）。`kind` 创建后不可变更。

use rusqlite::Connection;
use tauri::State;

use crate::error::AppError;
use crate::model::entities::{Annotation, NewAnnotation};
use crate::storage::db;
use crate::AppState;

/// annotations.kind 白名单。
const KINDS: [&str; 3] = ["highlight", "note", "bookmark"];
/// 未指定颜色时的默认值。
const DEFAULT_COLOR: &str = "yellow";

fn with_db<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    f(&conn)
}

/// 新建高亮/笔记/书签。校验 kind 白名单与 start<=end；书必须存在。
/// `page`：PDF 页码（1 基），重排书传 None；page 有值时要求 start/end 为 0
/// （PDF 无法用字符区间定位，见 docs/architecture.md §6.4）。
#[tauri::command]
pub fn create_annotation(
    state: State<'_, AppState>,
    book_id: i64,
    kind: String,
    chapter_idx: i64,
    start: i64,
    end: i64,
    text: Option<String>,
    color: Option<String>,
    page: Option<i64>,
) -> Result<Annotation, AppError> {
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::Internal(format!("invalid annotation kind: {kind}")));
    }
    if start < 0 || end < start {
        return Err(AppError::Internal(format!(
            "invalid annotation range: {start}..{end}"
        )));
    }
    if page.is_some() && (start != 0 || end != 0) {
        return Err(AppError::Internal(format!(
            "page-based annotation requires zero range, got: {start}..{end}"
        )));
    }
    let color = color
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| DEFAULT_COLOR.to_string());
    let new = NewAnnotation {
        book_id,
        kind,
        chapter_idx,
        start,
        end,
        text,
        color,
        page,
    };
    with_db(&state, |conn| {
        db::get_book(conn, book_id)?.ok_or_else(|| AppError::NotFound(format!("book #{book_id}")))?;
        let id = db::insert_annotation(conn, &new)?;
        db::get_annotation(conn, id)?
            .ok_or_else(|| AppError::Internal(format!("inserted annotation #{id} missing")))
    })
}

/// 整书标注（按 chapter_idx, start 排序）。
#[tauri::command]
pub fn list_annotations(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<Vec<Annotation>, AppError> {
    with_db(&state, |conn| db::list_annotations(conn, book_id))
}

/// 部分更新：note_body / color 至少给出其一；kind 不可改。
#[tauri::command]
pub fn update_annotation(
    state: State<'_, AppState>,
    id: i64,
    note_body: Option<String>,
    color: Option<String>,
) -> Result<Annotation, AppError> {
    if note_body.is_none() && color.is_none() {
        return Err(AppError::Internal(
            "update_annotation requires note_body or color".to_string(),
        ));
    }
    with_db(&state, |conn| {
        db::update_annotation(conn, id, note_body.as_deref(), color.as_deref())
    })
}

/// 删除标注；不存在返回 NotFound。
#[tauri::command]
pub fn delete_annotation(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    with_db(&state, |conn| db::delete_annotation(conn, id))
}