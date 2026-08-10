//! 解析层（docs/architecture.md §5.1）：各格式归一化为 `DocumentModel`。

mod epub;
mod mobi;
mod pdf;
mod plaintext;

use std::path::Path;

use crate::error::AppError;
use crate::model::document::{DocumentModel, Format};

pub trait BookParser {
    fn parse(&self, file_path: &Path) -> Result<DocumentModel, AppError>;
}

/// 按格式分发解析器。解析未实现的格式返回 UnsupportedFormat。
pub fn for_format(format: Format) -> Box<dyn BookParser> {
    match format {
        Format::Epub => Box::new(epub::EpubParser),
        Format::Mobi => Box::new(mobi::MobiParser),
        Format::PlainText => Box::new(plaintext::PlainTextParser),
        Format::Markdown => Box::new(plaintext::MarkdownParser),
        Format::Pdf => Box::new(pdf::PdfParser),
    }
}

/// 常见命名字符实体 → 目标字符。
fn named_entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ensp" => ' ',
        "emsp" => ' ',
        "thinsp" => ' ',
        "mdash" => '\u{2014}',
        "ndash" => '\u{2013}',
        "hellip" => '\u{2026}',
        "ldquo" => '\u{201C}',
        "rdquo" => '\u{201D}',
        "lsquo" => '\u{2018}',
        "rsquo" => '\u{2019}',
        "copy" => '\u{00A9}',
        "reg" => '\u{00AE}',
        "trade" => '\u{2122}',
        "times" => '\u{00D7}',
        "divide" => '\u{00F7}',
        "bull" => '\u{2022}',
        "middot" => '\u{00B7}',
        _ => return None,
    })
}

/// 解码文本事件中的实体引用（XML 5 预定义 + 常见 HTML 命名实体 + 数字引用）。
/// quick-xml 的 `unescape()` 只接受 XML 预定义实体，遇到 `&nbsp;` 等会报错，
/// 这里做宽松解码以兼容真实 EPUB/MOBI 文本。
pub(crate) fn decode_entities(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            // 收集到 `;`（或最长 16 字符）为止
            let mut name = String::new();
            let mut j = i + 1;
            while j < chars.len() && chars[j] != ';' && name.len() < 16 {
                name.push(chars[j]);
                j += 1;
            }
            if j < chars.len() && chars[j] == ';' {
                if let Some(c) = char_ref(&name) {
                    out.push(c);
                    i = j + 1;
                    continue;
                }
            }
            out.push('&');
            i += 1;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// `#123` / `#x1F` 数字引用或命名实体 → 字符。
fn char_ref(name: &str) -> Option<char> {
    if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
        u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
    } else if let Some(dec) = name.strip_prefix('#') {
        dec.parse::<u32>().ok().and_then(char::from_u32)
    } else {
        named_entity(name)
    }
}

/// 单个实体引用名（quick-xml 的 `Event::GeneralRef`，不含 `&`/`;`）→ 目标字符。
pub(crate) fn decode_char_ref(name: &[u8]) -> Option<char> {
    char_ref(&String::from_utf8_lossy(name))
}

/// 追加单个实体引用到缓冲；未知实体原样保留 `&name;`。
pub(crate) fn push_ref(buf: &mut String, name: &[u8]) {
    match decode_char_ref(name) {
        Some(c) => buf.push(c),
        None => {
            buf.push('&');
            buf.push_str(&String::from_utf8_lossy(name));
            buf.push(';');
        }
    }
}