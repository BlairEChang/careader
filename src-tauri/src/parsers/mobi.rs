//! MOBI 解析（mobi crate 封装）—— docs/architecture.md §8 已知取舍：
//! 图片/内嵌字体不提取，统一降级为纯文本。
//!
//! 章节：按正文（mobi crate 还原的 HTML）中 h1-h6 切分，每条标题后到下一标题
//! 之间的段落构成一章；无任何标题时全书为单章。章节 id 用索引字符串，
//! 章节标题取对应标题文本，空标题回退「第 N 节」（首章空标题用书名）。

use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::AppError;
use crate::model::document::{Chapter, DocumentModel, Element, Format};
use crate::parsers::{decode_entities, push_ref, BookParser};

#[derive(Debug, Clone, Copy)]
pub struct MobiParser;

impl BookParser for MobiParser {
    fn parse(&self, file_path: &Path) -> Result<DocumentModel, AppError> {
        let m = mobi::Mobi::from_path(file_path)
            .map_err(|e| AppError::ParseFailed(format!("mobi 解析失败: {e}")))?;
        let title = m.title();
        let author = m.author().unwrap_or_default();
        let html = m.content_as_string_lossy();
        let chapters = split_mobi_html(&html);

        // 章节标题兜底：空标题 → 书名（首章）/「第 N 节」
        let chapters: Vec<Chapter> = chapters
            .into_iter()
            .enumerate()
            .map(|(i, (t, content))| {
                let t = if t.trim().is_empty() {
                    if i == 0 {
                        title.clone()
                    } else {
                        format!("第 {} 节", i + 1)
                    }
                } else {
                    t
                };
                Chapter {
                    id: i.to_string(),
                    title: t,
                    content,
                    resources: Vec::new(),
                }
            })
            .collect();

        Ok(DocumentModel {
            format: Format::Mobi,
            title,
            authors: if author.is_empty() {
                Vec::new()
            } else {
                vec![author]
            },
            language: None,
            chapters,
            cover: None,
        })
    }
}

/// 当前章节（不存在则新建）的内容列表，供段落追加。
fn current_els(chapters: &mut Vec<(String, Vec<Element>)>) -> &mut Vec<Element> {
    if chapters.is_empty() {
        chapters.push((String::new(), Vec::new()));
    }
    &mut chapters.last_mut().unwrap().1
}

/// 段落缓冲收尾为 Paragraph（空缓冲不产出）。
fn push_para(para: &mut String, els: &mut Vec<Element>) {
    let p = para.trim().to_string();
    if !p.is_empty() {
        els.push(Element::Paragraph { text: p });
    }
    *para = String::new();
}

/// 按 h1-h6 把 mobi 正文 HTML 切分为章节（标题为章边界，标题文本不进入正文）。
/// 无任何标题时返回单章。段落标签 p/div/li 等之间的文本合并为 Paragraph。
fn split_mobi_html(html: &str) -> Vec<(String, Vec<Element>)> {
    let mut reader = Reader::from_str(html);
    let mut chapters: Vec<(String, Vec<Element>)> = Vec::new();
    let mut heading_buf: Option<String> = None;
    let mut para = String::new();
    let mut skip = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let n = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();
                match n.as_str() {
                    "script" | "style" | "head" => skip += 1,
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        // 前一章残余段落收尾，然后开新章并进入标题捕获
                        push_para(&mut para, current_els(&mut chapters));
                        chapters.push((String::new(), Vec::new()));
                        heading_buf = Some(String::new());
                    }
                    "p" | "div" | "li" | "blockquote" | "td" | "th" => {
                        if heading_buf.is_none() {
                            push_para(&mut para, current_els(&mut chapters));
                        }
                    }
                    "br" | "hr" => {
                        if heading_buf.is_none() {
                            push_para(&mut para, current_els(&mut chapters));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                if skip == 0 {
                    let un = decode_entities(t.as_ref());
                    if !un.trim().is_empty() {
                        if let Some(h) = &mut heading_buf {
                            h.push_str(&un);
                        } else {
                            para.push_str(&un);
                        }
                    }
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if skip == 0 {
                    if let Some(h) = &mut heading_buf {
                        push_ref(h, r.as_ref());
                    } else {
                        push_ref(&mut para, r.as_ref());
                    }
                }
            }
            Ok(Event::End(e)) => {
                let n = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();
                match n.as_str() {
                    "script" | "style" | "head" => skip = skip.saturating_sub(1),
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        if let Some(h) = heading_buf.take() {
                            if let Some((t, _)) = chapters.last_mut() {
                                *t = h.trim().to_string();
                            }
                        }
                    }
                    "p" | "div" | "li" | "blockquote" | "td" | "th" => {
                        if heading_buf.is_none() {
                            push_para(&mut para, current_els(&mut chapters));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            _ => {}
        }
    }
    // 收尾：最后一章残余段落
    push_para(&mut para, current_els(&mut chapters));
    if chapters.len() > 1 && chapters[0].1.is_empty() && chapters[0].0.trim().is_empty() {
        // 无标题标题前的空手前奏章直接丢弃（如仅空格的 body 前缀）
        chapters.remove(0);
    }
    chapters
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_chapters_on_headings_and_strips_tags() {
        let html = "<html><body><h1>第一章</h1><p>第一段 <b>粗体</b>内容</p>\
                    <div>第二段</div><h2>第二章</h2><p>第三段</p></body></html>";
        let chapters = split_mobi_html(html);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].0, "第一章");
        assert_eq!(
            chapters[0].1,
            vec![
                Element::Paragraph { text: "第一段 粗体内容".into() },
                Element::Paragraph { text: "第二段".into() },
            ]
        );
        assert_eq!(chapters[1].0, "第二章");
        assert_eq!(chapters[1].1, vec![Element::Paragraph { text: "第三段".into() }]);
    }

    #[test]
    fn no_headings_is_single_chapter() {
        let chapters = split_mobi_html("<html><body><p>只有一段</p></body></html>");
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].0, "");
        assert_eq!(chapters[0].1, vec![Element::Paragraph { text: "只有一段".into() }]);
    }

    #[test]
    fn entities_are_decoded() {
        let chapters = split_mobi_html("<html><body><p>a&amp;b &lt;c&gt; &nbsp;x</p></body></html>");
        assert_eq!(chapters[0].1[0], Element::Paragraph { text: "a&b <c> x".into() });
    }

    #[test]
    fn preamble_becomes_first_chapter() {
        let html = "<html><body><p>序言</p><h1>正章</h1><p>正文</p></body></html>";
        let chapters = split_mobi_html(html);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].0, ""); // 序言章标题由上层兜底
        assert_eq!(chapters[0].1, vec![Element::Paragraph { text: "序言".into() }]);
        assert_eq!(chapters[1].0, "正章");
    }
}