//! 资源字节读取命令（docs/android-port.md §4.2 回退路径）。
//!
//! asset protocol（convertFileSrc）在部分 Android 真机对 app_data_dir 下文件加载
//! 失败（tauri#14776），前端在 URL 加载失败时经本命令读取字节流回退。
//! 大文件（PDF）全量读入内存是回退路径的已知代价，前端仅在 URL 方案失败时调用。

use std::path::{Path, PathBuf};

use tauri::State;

use crate::error::AppError;
use crate::storage::fs;
use crate::AppState;

/// 读取书库内文件字节。路径必须落在 `{app_data_dir}/library` 内，越界一律按
/// FileNotFound 处理（不泄露书库外文件是否存在）。
#[tauri::command]
pub fn read_asset_bytes(state: State<'_, AppState>, path: String) -> Result<Vec<u8>, AppError> {
    let lib_dir = fs::library_dir(&state.app_data_dir);
    let file = resolve_in_library(&lib_dir, &path)?;
    std::fs::read(&file).map_err(AppError::Io)
}

/// 解析并校验书库内路径：
/// 1. 剥掉 Windows `\\?\` 前缀；
/// 2. 词法规范化 `.`/`..` 后先做一次前缀校验（防越界跳转）；
/// 3. canonicalize 解析符号链接并确认文件存在，再用真实路径二次校验。
fn resolve_in_library(lib_dir: &Path, raw: &str) -> Result<PathBuf, AppError> {
    let candidate = PathBuf::from(raw.strip_prefix(r"\\?\").unwrap_or(raw));
    let normalized = lexical_normalize(&candidate);
    if !normalized.starts_with(lib_dir) {
        return Err(AppError::FileNotFound(raw.to_string()));
    }
    let file = match std::fs::canonicalize(&normalized) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::FileNotFound(raw.to_string()));
        }
        Err(e) => return Err(AppError::Io(e)),
    };
    // 书库目录缺失时视为文件不存在。
    let lib_real = std::fs::canonicalize(lib_dir).map_err(|_| AppError::FileNotFound(raw.to_string()))?;
    if !file.starts_with(&lib_real) {
        return Err(AppError::FileNotFound(raw.to_string()));
    }
    Ok(file)
}

/// 词法规范化：解析 `.`/`..`（不触盘）。根目录处的 `..` 直接忽略，不会越过根。
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if matches!(out.components().next_back(), Some(std::path::Component::Normal(_))) {
                    out.pop();
                }
            }
            _ => out.push(comp.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_normalize_resolves_curdir_and_parentdir() {
        // 比较 PathBuf（组件比较，跨平台分隔符不敏感）。
        assert_eq!(
            lexical_normalize(Path::new("a/./b/../c")),
            PathBuf::from("a/c")
        );
        assert_eq!(
            lexical_normalize(Path::new("/a/../../b")),
            PathBuf::from("/b")
        );
    }
}
