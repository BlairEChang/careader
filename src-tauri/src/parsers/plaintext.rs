//! TXT / Markdown 解析（docs/architecture.md §5.1 / §6.1）。
//!
//! - TXT：UTF-8 优先，失败回退 GB18030 探测；按 `第X章` 类标记启发式切分章节，
//!   未命中任何标记时全书为单章。
//! - MD：按一级标题（`#`）切分章节，其余标题作为 Heading 元素。
//! - 元数据：无内嵌元数据，标题取文件名（MD 首个一级标题优先）。

use std::path::Path;

use crate::error::AppError;
use crate::model::document::{Chapter, DocumentModel, Element, Format};
use crate::parsers::BookParser;

static CHAPTER_ENDS: [char; 5] = ['章', '节', '回', '卷', '篇'];

fn is_cn_numeral(c: char) -> bool {
    "一二三四五六七八九十百千零两".contains(c)
}

/// 判断一行是否为 TXT 章节标记（如“第一章”“第 12 节”“第百回”）。
fn is_txt_chapter_marker(line: &str) -> bool {
    let trimmed = line.trim();
    let Some(rest) = trimmed.strip_prefix('第') else {
        return false;
    };
    let Some(end_idx) = rest.find(CHAPTER_ENDS) else {
        return false;
    };
    let head = &rest[..end_idx];
    !head.is_empty()
        && head
            .chars()
            .all(|c| c.is_ascii_digit() || is_cn_numeral(c) || c.is_whitespace() || c == '·')
}

/// 按空行切分段落（空白行作为段落分隔，连续空行忽略）。
fn split_paragraphs(text: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(trimmed.to_string());
        }
    }
    if !current.is_empty() {
        paragraphs.push(current.join("\n"));
    }
    paragraphs
}

/// 按章节标记把段落序列切分为章节。无标记时全书为单章。
/// 标记段落本身不进入正文（其文本作为章标题）。
fn split_chapters_by_markers(
    title: &str,
    paragraphs: Vec<String>,
) -> Vec<(String, Vec<Element>)> {
    let mut chapters: Vec<(String, Vec<Element>)> = Vec::new();
    let mut current_title = String::new();
    let mut content: Vec<Element> = Vec::new();

    for para in paragraphs {
        if is_txt_chapter_marker(&para) {
            if !content.is_empty() || !chapters.is_empty() {
                chapters.push((std::mem::take(&mut current_title), std::mem::take(&mut content)));
            }
            current_title = para.trim().to_string();
        } else {
            content.push(Element::Paragraph { text: para });
        }
    }
    if !content.is_empty() || chapters.is_empty() {
        chapters.push((current_title, content));
    }
    chapters
        .into_iter()
        .enumerate()
        .map(|(i, (t, c))| {
            if t.trim().is_empty() {
                (if i == 0 { title.to_string() } else { format!("第 {} 节", i + 1) }, c)
            } else {
                (t, c)
            }
        })
        .collect()
}

fn file_name_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名")
        .to_string()
}

/// 读取文件并按编码探测解码（UTF-8 优先，失败回退 GB18030）。
fn read_text(path: &Path) -> Result<String, AppError> {
    let bytes = std::fs::read(path)?;
    Ok(decode_text(&bytes))
}

fn decode_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GB18030.decode(bytes);
            decoded.into_owned()
        }
    }
}

/// Markdown 切分：一级标题为章边界，二级及以下标题入正文作为 Heading。
/// 返回 (书名, 章节列表)；书名取首个一级标题，否则回退文件名。
fn split_markdown(file_name: &str, text: &str) -> (String, Vec<(String, Vec<Element>)>) {
    let mut title = file_name.to_string();
    let mut chapters: Vec<(String, Vec<Element>)> = Vec::new();
    let mut content: Vec<Element> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let level = rest.chars().take_while(|c| *c == '#').count();
            let heading_text = rest[level..].trim().to_string();
            if level == 0 {
                if !content.is_empty() || !chapters.is_empty() {
                    chapters.push((String::new(), std::mem::take(&mut content)));
                }
                if title == file_name && !heading_text.is_empty() {
                    title = heading_text.clone();
                }
                content.push(Element::Heading { text: heading_text });
            } else {
                content.push(Element::Heading { text: heading_text });
            }
        } else if !trimmed.is_empty() {
            content.push(Element::Paragraph { text: trimmed.to_string() });
        }
    }
    if !content.is_empty() || chapters.is_empty() {
        chapters.push((String::new(), content));
    }
    chapters = chapters
        .into_iter()
        .enumerate()
        .map(|(i, (t, c))| {
            let (t, c) = match c.first() {
                Some(Element::Heading { text }) => (text.clone(), c.into_iter().skip(1).collect()),
                _ => (t, c),
            };
            let t = if t.trim().is_empty() {
                format!("第 {} 节", i + 1)
            } else {
                t
            };
            (t, c)
        })
        .collect();
    (title, chapters)
}

fn build_model(format: Format, title: String, chapters: Vec<(String, Vec<Element>)>) -> DocumentModel {
    DocumentModel {
        format,
        title,
        authors: Vec::new(),
        language: None,
        chapters: chapters
            .into_iter()
            .enumerate()
            .map(|(i, (title, content))| Chapter {
                id: i.to_string(),
                title,
                content,
                resources: Vec::new(),
            })
            .collect(),
        cover: None,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PlainTextParser;

impl BookParser for PlainTextParser {
    fn parse(&self, file_path: &Path) -> Result<DocumentModel, AppError> {
        let text = read_text(file_path)?;
        let title = file_name_stem(file_path);
        let chapters = split_chapters_by_markers(&title, split_paragraphs(&text));
        Ok(build_model(Format::PlainText, title, chapters))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MarkdownParser;

impl BookParser for MarkdownParser {
    fn parse(&self, file_path: &Path) -> Result<DocumentModel, AppError> {
        let text = read_text(file_path)?;
        let file_name = file_name_stem(file_path);
        let (title, chapters) = split_markdown(&file_name, &text);
        Ok(build_model(Format::Markdown, title, chapters))
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapter_marker_detection() {
        assert!(is_txt_chapter_marker("第一章"));
        assert!(is_txt_chapter_marker("  第 12 节"));
        assert!(is_txt_chapter_marker("第一百零八回"));
        assert!(is_txt_chapter_marker("第一章第一节第四章")); // 头为序数即命中
        assert!(!is_txt_chapter_marker("第"));
        assert!(!is_txt_chapter_marker("第章")); // 标记与数字/序数之间无内容
        assert!(!is_txt_chapter_marker("前言"));
    }

    #[test]
    fn txt_splits_on_markers() {
        let text = "序言内容\n\n第一章 启程\n\n他出发了。\n\n第二章 归来\n\n他回来了。";
        let chapters = split_chapters_by_markers("书名", split_paragraphs(text));
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].0, "书名");
        assert_eq!(chapters[1].0, "第一章 启程");
        assert_eq!(chapters[2].0, "第二章 归来");
        assert_eq!(
            chapters[1].1,
            vec![Element::Paragraph { text: "他出发了。".into() }]
        );
    }

    #[test]
    fn txt_single_chapter_fallback() {
        let text = "只有一段没有章节标记。";
        let chapters = split_chapters_by_markers("孤本", split_paragraphs(text));
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].0, "孤本");
    }

    #[test]
    fn md_splits_on_h1() {
        let text = "# 三体\n\n## 序\n\n正文一\n\n# 第一部\n\n正文二";
        let (title, chapters) = split_markdown("三体.md", text);
        assert_eq!(title, "三体");
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].0, "三体");
        assert_eq!(chapters[1].0, "第一部");
        assert_eq!(
            chapters[0].1,
            vec![
                Element::Heading { text: "序".into() },
                Element::Paragraph { text: "正文一".into() },
            ]
        );
    }

    #[test]
    fn md_without_h1_falls_back_to_title() {
        let (title, chapters) = split_markdown("随笔.md", "## 小节\n\n内容");
        assert_eq!(title, "随笔.md"); // 无 h1，保留文件名
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].0, "小节"); // 首个标题作为章标题
        assert_eq!(chapters[0].1, vec![Element::Paragraph { text: "内容".into() }]);
    }

    #[test]
    fn gb18030_fallback_decode() {
        // “你好” 的 GBK 字节（非法 UTF-8 序列）
        let bytes = [0xc4, 0xe3, 0xba, 0xc3];
        assert!(std::str::from_utf8(&bytes).is_err());
        assert_eq!(decode_text(&bytes), "你好");
        assert_eq!(decode_text("你好" .as_bytes()), "你好");
    }
}
