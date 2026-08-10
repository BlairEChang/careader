//! 书架/书库命令（docs/architecture.md §6.1）。
//!
//! `import_books` 为批次语义：解析失败的书不中断批量，逐本返回
//! `{ ok_items, failed: [(path, reason)] }`，由前端 Toast 汇总。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::model::document::Format;
use crate::model::entities::Book;
use crate::parsers;
use crate::storage::{db, fs};
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub succeeded: Vec<Book>,
    pub failed: Vec<FailedImport>,
}

#[derive(Debug, Serialize)]
pub struct FailedImport {
    pub path: String,
    pub reason: String,
}

/// 导入一批书。解析失败的单本不中断批次，从库里清理拷贝后记入 failed。
#[tauri::command]
pub fn import_books(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ImportResult, AppError> {
    let lib_dir = fs::library_dir(&state.app_data_dir);
    let mut result = ImportResult {
        succeeded: Vec::new(),
        failed: Vec::new(),
    };
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;

    for raw in paths {
        let path = PathBuf::from(&raw);
        match import_one(&conn, &lib_dir, &path) {
            Ok(book) => result.succeeded.push(book),
            Err(e) => result.failed.push(FailedImport {
                path: raw.clone(),
                reason: e.to_string(),
            }),
        }
    }
    Ok(result)
}

/// Android 移动端导入：dialog.open() 在 Android 返回 content:// URI，
/// std::fs 无法直接读取，经 tauri-plugin-android-fs（ContentResolver）流式
/// 拷入书库临时文件后复用 `import_one`。桌面端返回 NOT_ANDROID 错误。
#[tauri::command]
pub fn import_books_from_uris(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    uris: Vec<String>,
) -> Result<ImportResult, AppError> {
    use tauri_plugin_android_fs::{AndroidFsExt, FsUri};

    let lib_dir = fs::library_dir(&state.app_data_dir);
    let mut result = ImportResult {
        succeeded: Vec::new(),
        failed: Vec::new(),
    };
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    let afs = app.android_fs();

    for uri in uris {
        let furi = FsUri::from_uri(&uri);
        let name = match afs.get_name(&furi) {
            Ok(n) => n,
            Err(e) => {
                result.failed.push(FailedImport { path: uri.clone(), reason: e.to_string() });
                continue;
            }
        };
        let mut src = match afs.open_file_readable(&furi) {
            Ok(f) => f,
            Err(e) => {
                result.failed.push(FailedImport { path: uri.clone(), reason: e.to_string() });
                continue;
            }
        };
        // 临时文件落在书库目录内，名字保留原文件名（含扩展名），供 import_one
        // 探测格式、拷贝入库；完成后清理临时文件。
        let tmp = lib_dir.join(format!(".import-{}", name));
        let mut tmp_file = match std::fs::File::create(&tmp) {
            Ok(f) => f,
            Err(e) => {
                result.failed.push(FailedImport { path: uri.clone(), reason: e.to_string() });
                continue;
            }
        };
        if let Err(e) = std::io::copy(&mut src, &mut tmp_file) {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp);
            result.failed.push(FailedImport { path: uri.clone(), reason: e.to_string() });
            continue;
        }
        drop(tmp_file);
        match import_one(&conn, &lib_dir, &tmp) {
            Ok(book) => result.succeeded.push(book),
            Err(e) => result.failed.push(FailedImport { path: uri.clone(), reason: e.to_string() }),
        }
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result)
}

fn import_one(conn: &rusqlite::Connection, lib_dir: &Path, src: &Path) -> Result<Book, AppError> {
    if !src.exists() {
        return Err(AppError::FileNotFound(src.display().to_string()));
    }
    let format = Format::from_path(src).ok_or_else(|| {
        AppError::UnsupportedFormat(format!(
            "无法识别的扩展名: {}",
            src.extension().and_then(|e| e.to_str()).unwrap_or("无")
        ))
    })?;

    // 先拷贝进书库，再解析（EPUB 解析期间会把图片/封面解压到
    // `{library}/{stem}/` 资源目录）；失败时书文件与资源目录一并清理。
    let dest = fs::copy_into_library(src, lib_dir)?;
    let asset_dir = fs::asset_dir_from_book_path(&dest);
    let model = match parsers::for_format(format).parse(&dest) {
        Ok(m) => m,
        Err(e) => {
            fs::remove_library_files(&[&dest]);
            fs::remove_book_assets(&asset_dir);
            return Err(e);
        }
    };

    // 封面：M3 起 DocumentModel.cover 为封面文件的磁盘绝对路径（解析时已落盘）。
    let book = Book {
        id: 0,
        title: model.title,
        authors: model.authors,
        format,
        file_path: dest.display().to_string(),
        cover_path: model.cover,
        added_at: db::now_secs(),
        last_opened_at: None,
    };
    let id = db::insert_book(conn, &book).map_err(|e| {
        fs::remove_library_files(&[&dest]);
        fs::remove_book_assets(&asset_dir);
        e
    })?;
    Ok(Book { id, ..book })
}

/// 书架列表（按入库时间倒序）。
#[tauri::command]
pub fn list_books(state: State<'_, AppState>) -> Result<Vec<Book>, AppError> {
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    db::list_books(&conn)
}

/// 移除某本书：删库记录（级联清进度/标注）+ 清理书文件与资源目录（图片/封面）。
#[tauri::command]
pub fn remove_book(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let conn = state.db.lock().map_err(|_| AppError::Internal("state lock poisoned".to_string()))?;
    let book = db::delete_book(&conn, id)?;
    drop(conn);
    let book_path = Path::new(&book.file_path);
    fs::remove_library_files(&[book_path]);
    fs::remove_book_assets(&fs::asset_dir_from_book_path(book_path));
    Ok(())
}