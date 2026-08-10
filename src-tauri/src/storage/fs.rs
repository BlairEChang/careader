//! 书库文件系统（docs/architecture.md §6.1）：书库目录布局、导入拷贝（重名加
//! 后缀）、删除清理。封面落盘（M3）与资源暴露（M5）在此扩展。

use std::path::{Path, PathBuf};

use crate::error::AppError;

pub const LIBRARY_DIR_NAME: &str = "library";

/// 书库根目录：`{app_data_dir}/library`。
pub fn library_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LIBRARY_DIR_NAME)
}

/// 目标名已存在时追加 ` (n)` 后缀，返回可安全使用的路径。
fn unique_dest(lib_dir: &Path, stem: &str, ext: Option<&str>) -> PathBuf {
    let candidate = |n: usize| -> PathBuf {
        let name = if n == 0 {
            stem.to_string()
        } else {
            format!("{stem} ({n})")
        };
        match ext {
            Some(ext) => lib_dir.join(format!("{name}.{ext}")),
            None => lib_dir.join(name),
        }
    };
    let mut n = 0;
    loop {
        let dest = candidate(n);
        if !dest.exists() {
            return dest;
        }
        n += 1;
    }
}

/// 把用户选择的书拷贝进书库（重名自动加后缀），返回库内绝对路径。
pub fn copy_into_library(src: &Path, lib_dir: &Path) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(lib_dir)?;
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名");
    let ext = src.extension().and_then(|e| e.to_str());
    let dest = unique_dest(lib_dir, stem, ext);
    std::fs::copy(src, &dest)?;
    Ok(dest)
}

/// 删除书库文件（书支持的书文件；封面在 M3 起参与清理）。
pub fn remove_library_files(paths: &[&Path]) {
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
}

/// 书的资源目录：`{library}/{stem}/`，存放该书解压出的图片与封面。
/// 与书文件同名同目录，保证书名冲突时（copy_into_library 加后缀）资源目录也唯一。
pub fn asset_dir(lib_dir: &Path, book_stem: &str) -> PathBuf {
    lib_dir.join(book_stem)
}

/// 由书文件在库内的绝对路径推导资源目录。
pub fn asset_dir_from_book_path(book_path: &Path) -> PathBuf {
    let stem = book_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名");
    let lib_dir = book_path.parent().unwrap_or_else(|| Path::new(""));
    asset_dir(lib_dir, stem)
}

/// 删除整本书的资源目录（不存在时静默，删除失败仅告警）。
pub fn remove_book_assets(dir: &Path) {
    if let Err(e) = std::fs::remove_dir_all(dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[fs] 清理资源目录失败 {}: {e}", dir.display());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_into_library_dedupes_names() {
        let dir = std::env::temp_dir().join(format!(
            "careader-fs-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("小说.txt");
        std::fs::write(&src, "内容").unwrap();

        let lib = dir.join("library");
        let d1 = copy_into_library(&src, &lib).unwrap();
        let d2 = copy_into_library(&src, &lib).unwrap();
        assert_ne!(d1, d2);
        assert!(d1.exists() && d2.exists());
        assert_eq!(d2.file_name().unwrap().to_str().unwrap(), "小说 (1).txt");

        remove_library_files(&[&d1, &d2]);
        assert!(!d1.exists() && !d2.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
