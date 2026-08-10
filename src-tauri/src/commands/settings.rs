//! 偏好设置命令（docs/architecture.md §6.6）。
//!
//! settings 表为 key-value（value 为 JSON 编码），key 白名单在
//! `model/entities.rs` 侧约定（fontSize / lineHeight / fontFamily /
//! theme / paginationMode）。前端启动时一次性水合，变更防抖回写。

use std::collections::HashMap;

use serde_json::Value;
use tauri::State;

use crate::error::AppError;
use crate::storage::db;
use crate::AppState;

/// 启动水合：返回全部设置。
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, Value>, AppError> {
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    db::get_settings(&conn)
}

/// 写入单个设置（按 key UPSERT）。
#[tauri::command]
pub fn set_settings(
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> Result<(), AppError> {
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    db::set_setting(&conn, &key, value)
}