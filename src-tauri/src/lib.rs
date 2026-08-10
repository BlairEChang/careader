//! careader 后端装配：插件、AppState（SQLite + 书库目录）、commands 注册。

mod commands;
mod error;
mod model;
mod parsers;
mod storage;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

use tauri::Manager;

pub use error::AppError;

/// 跨 command 共享的应用状态。
pub struct AppState {
    /// 单连接 + Mutex：Tauri command 默认在线程池执行，SQLite 连接非 Send 时
    /// 由 Mutex 串行化访问。
    pub db: Mutex<Connection>,
    /// 应用数据目录（书库目录为其子目录）。
    pub app_data_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("careader.db");
            let conn = storage::db::open(&db_path)?;
            app.manage(AppState {
                db: Mutex::new(conn),
                app_data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library::import_books,
            commands::library::list_books,
            commands::library::remove_book,
            commands::reading::open_book,
            commands::reading::get_toc,
            commands::reading::list_progress,
            commands::reading::save_progress,
            commands::annotations::create_annotation,
            commands::annotations::list_annotations,
            commands::annotations::update_annotation,
            commands::annotations::delete_annotation,
            commands::settings::get_settings,
            commands::settings::set_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
