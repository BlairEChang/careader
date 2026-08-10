//! PDF 解析（docs/architecture.md §5.1 / §6.4）。
//!
//! PDF 的正文渲染全在前端（pdf.js 整页管线），后端只负责元数据：
//! 标题取文件名（file_stem）、无作者、无章节正文、无封面。导入时
//! 不读文件内容，仅做存在性检查；渲染与页数信息由前端经 asset
//! protocol 读取原文件获得。

use std::path::Path;

use crate::error::AppError;
use crate::model::document::{DocumentModel, Format};
use crate::parsers::BookParser;

#[derive(Debug, Clone, Copy)]
pub struct PdfParser;

impl BookParser for PdfParser {
    fn parse(&self, file_path: &Path) -> Result<DocumentModel, AppError> {
        if !file_path.exists() {
            return Err(AppError::FileNotFound(file_path.display().to_string()));
        }
        let title = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名")
            .to_string();
        Ok(DocumentModel {
            format: Format::Pdf,
            title,
            authors: Vec::new(),
            language: None,
            chapters: Vec::new(),
            cover: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn pdf_metadata_only_model() {
        let dir = std::env::temp_dir().join(format!("careader_pdf_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("示例文档.pdf");
        File::create(&path).unwrap().write_all(b"%PDF-1.4 fake").unwrap();

        let model = PdfParser.parse(&path).unwrap();
        assert_eq!(model.format, Format::Pdf);
        assert_eq!(model.title, "示例文档");
        assert!(model.authors.is_empty());
        assert!(model.chapters.is_empty());
        assert_eq!(model.cover, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pdf_missing_file_is_file_not_found() {
        let missing = std::env::temp_dir().join("careader_pdf_missing_do_not_exist.pdf");
        let err = PdfParser.parse(&missing).unwrap_err();
        assert!(matches!(err, AppError::FileNotFound(_)));
    }
}
