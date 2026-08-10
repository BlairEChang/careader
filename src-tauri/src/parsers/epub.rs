//! EPUB 解析（docs/architecture.md §5.1 / M3）—— zip + quick-xml 自制封装。
//!
//! 管线：container.xml → rootfile 指向的 OPF → 元数据/manifest/spine →
//! TOC（优先 EPUB3 `properties="navigation"` 的 nav，回退 EPUB2 ncx）→
//! 按 spine 逐个解析 XHTML 为结构化 Element。
//!
//! 资源落盘：正文 `<img>` 引用的 manifest 条目与封面在解析期间从 zip 解压到
//! `{library}/{stem}/` 资源目录（fs.rs），`Resource.path`、`Image.src`、
//! `DocumentModel.cover` 均为磁盘绝对路径，前端用 convertFileSrc 暴露。
//!
//! 容错约定：container/opf/spine 等关键结构缺失报 ParseFailed（带原因）；
//! TOC 缺失时按 spine 顺序生成章节；单个资源解压失败仅告警不中断导入。

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek};
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use crate::error::AppError;
use crate::model::document::{Chapter, DocumentModel, Element, Format, Resource};
use crate::parsers::{decode_entities, push_ref, BookParser};
use crate::storage::fs;

#[derive(Debug, Clone, Copy)]
pub struct EpubParser;

impl BookParser for EpubParser {
    fn parse(&self, file_path: &Path) -> Result<DocumentModel, AppError> {
        let zip_file = std::fs::File::open(file_path)
            .map_err(|e| parse_err(format!("无法打开 EPUB 文件: {e}")))?;
        let mut zip = zip::ZipArchive::new(zip_file)
            .map_err(|e| parse_err(format!("无效的 EPUB(zip 结构): {e}")))?;

        // 1. container.xml → OPF 入口
        let container = zip_entry_bytes(&mut zip, "META-INF/container.xml")?
            .ok_or_else(|| parse_err("缺少 META-INF/container.xml".to_string()))?;
        let opf_entry = parse_container(&String::from_utf8_lossy(&container))?;
        let opf_dir = entry_dir(&opf_entry);
        let opf_bytes = zip_entry_bytes(&mut zip, &opf_entry)?
            .ok_or_else(|| parse_err(format!("container 指向的 OPF 不存在: {opf_entry}")))?;
        let opf = parse_opf(&String::from_utf8_lossy(&opf_bytes), &opf_dir)?;
        let by_entry: HashMap<String, (String, String)> = opf
            .manifest
            .iter()
            .map(|(id, it)| (it.entry.clone(), (id.clone(), it.media_type.clone())))
            .collect();

        // 2. TOC：EPUB3 nav 优先，回退 EPUB2 ncx
        let toc = parse_toc(&mut zip, &opf)?;

        // 3. 资源目录（与书文件同名、同位于库目录下的子目录），章节图片与封面落于此
        let asset_dir = fs::asset_dir_from_book_path(file_path);
        std::fs::create_dir_all(&asset_dir)?;

        // 4. spine → 章节（非 XHTML 条目跳过）
        let mut chapters = Vec::new();
        let mut to_extract: HashSet<String> = HashSet::new();
        for id in &opf.spine {
            let Some(item) = opf.manifest.get(id) else { continue };
            if !item.is_xhtml() {
                continue;
            }
            let entry = &item.entry;
            let Some(bytes) = zip_entry_bytes(&mut zip, entry).ok().flatten() else {
                eprintln!("[epub] spine 条目缺失或不可读: {entry}");
                continue;
            };
            let (elements, res, first_heading) =
                parse_xhtml_content(&String::from_utf8_lossy(&bytes), entry, &asset_dir, &by_entry);

            // 章节标题：TOC label(href 匹配) > 正文首个 h1-h6 > 第 N 章
            let toc_title = toc
                .iter()
                .find(|t| !t.title.trim().is_empty() && strip_fragment(&t.href) == strip_fragment(entry))
                .map(|t| t.title.clone());
            let title = toc_title
                .or(first_heading)
                .unwrap_or_else(|| format!("第 {} 章", chapters.len() + 1));
            for r in &res {
                to_extract.insert(r.1.clone());
            }
            chapters.push(Chapter {
                id: id.clone(),
                title,
                content: elements,
                resources: res.into_iter().map(|(r, _)| r).collect(),
            });
        }

        // 5. 资源解压落盘（失败仅告警，不阻塞导入）
        for entry in &to_extract {
            extract_asset(&mut zip, entry, &asset_dir);
        }

        // 6. 封面：meta[name=cover][content=id] 或 manifest properties=cover-image；
        //    落盘为 `{asset_dir}/cover.{ext}`。封面缺失/失败不影响导入（cover=None）。
        let cover = cover_path(&mut zip, &opf, &asset_dir)?;

        Ok(DocumentModel {
            format: Format::Epub,
            title: opf.title,
            authors: opf.authors,
            language: opf.language,
            chapters,
            cover,
        })
    }
}

// ---------- zip 读取 ----------

/// 读取 zip 内条目。条目不存在返回 Ok(None)，解压/读取失败返回 Err。
fn zip_entry_bytes<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<Option<Vec<u8>>, AppError> {
    let mut file = match zip.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(parse_err(format!("解压条目 {name} 失败: {e}"))),
    };
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| parse_err(format!("读取条目 {name} 失败: {e}")))?;
    Ok(Some(buf))
}

/// 把单个资源条目解压到资源目录（zip-slip 防护：含 `..` 等危险段则跳过）。
fn extract_asset<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    entry: &str,
    asset_dir: &Path,
) {
    let Some(rel) = safe_rel(entry) else {
        eprintln!("[epub] 跳过危险条目: {entry}");
        return;
    };
    let dest = asset_dir.join(&rel);
    let mut src = match zip.by_name(entry) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[epub] 条目不可读 {entry}: {e}");
            return;
        }
    };
    if let Some(parent) = dest.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[epub] 创建资源目录失败 {}: {e}", parent.display());
            return;
        }
    }
    if let Err(e) = std::fs::File::create(&dest).and_then(|mut f| std::io::copy(&mut src, &mut f)) {
        eprintln!("[epub] 资源落盘失败 {entry} -> {}: {e}", dest.display());
    }
}

/// 条目名转为资源目录内安全相对路径：拒绝 `..`/绝对路径段，替换平台危险字符。
fn safe_rel(entry: &str) -> Option<String> {
    let mut segs = Vec::new();
    for seg in entry.split('/') {
        match seg {
            "" | "." => {}
            ".." => return None,
            s if s.is_empty() => {}
            s => segs.push(s.replace('\\', "_").replace(':', "_")),
        }
    }
    if segs.is_empty() {
        None
    } else {
        Some(segs.join("/"))
    }
}

/// 把相对 href 与基准目录拼接为 zip 根为原点的条目名。
fn join_hrefs(base: &str, href: &str) -> String {
    let mut segs: Vec<String> = Vec::new();
    let raw = if base.is_empty() {
        href.to_string()
    } else {
        format!("{base}/{href}")
    };
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            p => segs.push(p.to_string()),
        }
    }
    segs.join("/")
}

/// 条目名的目录部分（不含最后一段）。
fn entry_dir(entry: &str) -> String {
    match entry.rfind('/') {
        Some(i) => entry[..i].to_string(),
        None => String::new(),
    }
}

/// 去掉 URL 片段锚点（#start 等）。
fn strip_fragment(href: &str) -> String {
    match href.split('#').next() {
        Some(h) => h.to_string(),
        None => href.to_string(),
    }
}

/// XML 本地名（去掉命名空间前缀，如 `dc:title` → `title`）。
fn local(name: &[u8]) -> &[u8] {
    match name.iter().rposition(|&b| b == b':') {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

fn as_lower(name: &[u8]) -> String {
    String::from_utf8_lossy(name).to_ascii_lowercase()
}

fn parse_err(msg: String) -> AppError {
    AppError::ParseFailed(msg)
}

// ---------- container / OPF ----------

/// 解析 container.xml，返回 rootfile 的 full-path。
fn parse_container(xml: &str) -> Result<String, AppError> {
    let mut reader = Reader::from_str(xml);
    let mut full_path: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e))
                if local(e.name().as_ref()) == b"rootfile" =>
            {
                full_path = attr(&e, b"full-path");
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(parse_err(format!("container.xml 解析失败: {e}"))),
            _ => {}
        }
    }
    full_path.ok_or_else(|| parse_err("container.xml 缺少 rootfile 条目".to_string()))
}

struct ManifestItem {
    /// 相对 OPF 目录解析后的 zip 条目名（zip 根为原点）。
    entry: String,
    /// 原始 href（仅用于取扩展名等）。
    href: String,
    media_type: String,
}

impl ManifestItem {
    fn is_xhtml(&self) -> bool {
        let mt = self.media_type.to_ascii_lowercase();
        mt == "text/html" || mt.contains("xhtml")
    }
}

struct Opf {
    title: String,
    authors: Vec<String>,
    language: Option<String>,
    manifest: HashMap<String, ManifestItem>,
    /// spine 中 itemref 的 idref 顺序。
    spine: Vec<String>,
    /// 封面 manifest id（meta[name=cover] 或 properties=cover-image）。
    cover_id: Option<String>,
    /// EPUB2 ncx / EPUB3 nav 的 manifest id。
    ncx_id: Option<String>,
    nav_id: Option<String>,
}

/// 解析 OPF：metadata(dc:title/creator/language + meta[name=cover])、
/// manifest(id→href/media-type/properties)、spine(idrefs)。
fn parse_opf(xml: &str, opf_dir: &str) -> Result<Opf, AppError> {
    let mut reader = Reader::from_str(xml);
    let (mut md_depth, mut mf_depth, mut sp_depth) = (0usize, 0usize, 0usize);
    let (mut title, mut language) = (String::new(), None);
    let mut authors: Vec<String> = Vec::new();
    let mut manifest: HashMap<String, ManifestItem> = HashMap::new();
    let (mut spine, mut cover_id, mut ncx_id, mut nav_id) = (Vec::new(), None, None, None);

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.name();
                let n = local(name.as_ref());
                match n {
                    b"metadata" => md_depth += 1,
                    b"manifest" => mf_depth += 1,
                    b"spine" => sp_depth += 1,
                    b"title" if md_depth > 0 && title.is_empty() => {
                        title = text_of(&mut reader)?;
                    }
                    b"creator" if md_depth > 0 => {
                        let t = text_of(&mut reader)?;
                        if !t.trim().is_empty() {
                            authors.push(t.trim().to_string());
                        }
                    }
                    b"language" if md_depth > 0 && language.is_none() => {
                        language = Some(text_of(&mut reader)?.trim().to_string());
                    }
                    b"meta" if md_depth > 0 => {
                        if attr(&e, b"name").as_deref() == Some("cover") {
                            cover_id = attr(&e, b"content");
                        }
                    }
                    b"item" if mf_depth > 0 => {
                        let Some(id) = attr(&e, b"id") else { continue };
                        let Some(href) = attr(&e, b"href") else { continue };
                        let media_type = attr(&e, b"media-type").unwrap_or_default();
                        let props: Vec<String> = attr(&e, b"properties")
                            .unwrap_or_default()
                            .split_whitespace()
                            .map(|s| s.to_string())
                            .collect();
                        if props.iter().any(|p| p == "cover-image") {
                            cover_id = Some(id.clone());
                        }
                        if media_type == "application/x-dtbncx+xml" {
                            ncx_id = Some(id.clone());
                        }
                        if props.iter().any(|p| p == "navigation") {
                            nav_id = Some(id.clone());
                        }
                        manifest.insert(
                            id,
                            ManifestItem {
                                entry: join_hrefs(opf_dir, &href),
                                href,
                                media_type,
                            },
                        );
                    }
                    b"itemref" if sp_depth > 0 => {
                        if let Some(idref) = attr(&e, b"idref") {
                            spine.push(idref);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => match local(e.name().as_ref()) {
                b"metadata" => md_depth = md_depth.saturating_sub(1),
                b"manifest" => mf_depth = mf_depth.saturating_sub(1),
                b"spine" => sp_depth = sp_depth.saturating_sub(1),
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(parse_err(format!("OPF 解析失败: {e}"))),
            _ => {}
        }
    }

    if manifest.is_empty() {
        return Err(parse_err("OPF manifest 为空".to_string()));
    }
    if spine.is_empty() {
        return Err(parse_err("OPF spine 为空".to_string()));
    }
    Ok(Opf {
        title,
        authors,
        language,
        manifest,
        spine,
        cover_id,
        ncx_id,
        nav_id,
    })
}

/// 读取当前元素的全部文本内容（到 End 为止），用于 dc:title 等叶子元素。
fn text_of(reader: &mut Reader<&[u8]>) -> Result<String, AppError> {
    let mut s = String::new();
    loop {
        match reader.read_event() {
Ok(Event::Text(t)) => {
                let un = decode_entities(t.as_ref());
                s.push_str(&un);
            }
            Ok(Event::GeneralRef(r)) => {
                push_ref(&mut s, r.as_ref());
            }
            Ok(Event::End(_)) => break,
            Ok(Event::Eof) => break,
            Err(e) => return Err(parse_err(format!("OPF 文本读取失败: {e}"))),
            _ => {}
        }
    }
    Ok(s)
}

// ---------- TOC（nav / ncx） ----------

struct TocEntry {
    /// zip 根为原点的解析后条目名。
    href: String,
    title: String,
}

/// 读取 TOC：EPUB3 nav（properties=navigation）优先，回退 EPUB2 ncx；均失败为空。
fn parse_toc<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, opf: &Opf) -> Result<Vec<TocEntry>, AppError> {
    if let Some(nav_id) = &opf.nav_id {
        if let Some(item) = opf.manifest.get(nav_id) {
            if let Ok(Some(bytes)) = zip_entry_bytes(zip, &item.entry) {
                let entries = parse_nav(&String::from_utf8_lossy(&bytes), &item.entry);
                if !entries.is_empty() {
                    return Ok(entries);
                }
            }
        }
    }
    if let Some(ncx_id) = &opf.ncx_id {
        if let Some(item) = opf.manifest.get(ncx_id) {
            if let Ok(Some(bytes)) = zip_entry_bytes(zip, &item.entry) {
                let entries = parse_ncx(&String::from_utf8_lossy(&bytes), &item.entry);
                if !entries.is_empty() {
                    return Ok(entries);
                }
            }
        }
    }
    Ok(Vec::new())
}

/// EPUB3 nav 文档（properties=navigation 的 XHTML）：取出 nav > ol > li 中
/// 每个 `a[href]` 的 (标题, 链接)，保留文档顺序（外层 li 在前）。
fn parse_nav(xml: &str, entry: &str) -> Vec<TocEntry> {
    let mut reader = Reader::from_str(xml);
    let base = entry_dir(entry);
    let (mut in_nav, mut li_depth) = (0usize, 0usize);
    let mut pending: Option<(String, String)> = None;
    let mut out: Vec<TocEntry> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let n = as_lower(e.name().as_ref());
                match n.as_str() {
                    "nav" => in_nav += 1,
                    "li" if in_nav > 0 => li_depth += 1,
                    "a" if in_nav > 0 && li_depth > 0 && pending.is_none() => {
                        if let Some(href) = attr(&e, b"href") {
                            pending = Some((join_hrefs(&base, &href), String::new()));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let n = as_lower(e.name().as_ref());
                if in_nav > 0 && li_depth > 0 && n == "a" {
                    if let Some(href) = attr(&e, b"href") {
                        out.push(TocEntry {
                            href: join_hrefs(&base, &href),
                            title: String::new(),
                        });
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if let Some((_, buf)) = &mut pending {
                    let un = decode_entities(t.as_ref());
                    buf.push_str(&un);
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if pending.is_some() {
                    push_ref(&mut pending.as_mut().unwrap().1, r.as_ref());
                }
            }
            Ok(Event::End(e)) => {
                let n = as_lower(e.name().as_ref());
                match n.as_str() {
                    "nav" => in_nav = in_nav.saturating_sub(1),
                    "li" => li_depth = li_depth.saturating_sub(1),
                    "a" => {
                        if let Some((href, text)) = pending.take() {
                            let t = text.trim().to_string();
                            if !t.is_empty() {
                                out.push(TocEntry { href, title: t });
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            _ => {}
        }
    }
    out
}

/// EPUB2 ncx：navPoint 序列（含嵌套），href 为 relative 到 ncx 所在目录的路径；
/// 全部 navPoint 有 playOrder 时按其排序，否则保持文档顺序。
fn parse_ncx(xml: &str, entry: &str) -> Vec<TocEntry> {
    let mut reader = Reader::from_str(xml);
    let base = entry_dir(entry);
    let mut pts: Vec<(Option<i64>, String, String)> = Vec::new();
    let (mut in_label, mut cur_play, mut cur_href, mut cur_label) = (false, None, String::new(), String::new());
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match local(e.name().as_ref()) {
                b"navPoint" => cur_play = attr(&e, b"playOrder").and_then(|p| p.trim().parse().ok()),
                b"navLabel" => {
                    in_label = true;
                    cur_label.clear();
                }
                b"content" => cur_href = attr(&e, b"src").unwrap_or_default(),
                _ => {}
            },
            Ok(Event::Text(t)) => {
                if in_label {
                    let un = decode_entities(t.as_ref());
                    cur_label.push_str(&un);
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if in_label {
                    push_ref(&mut cur_label, r.as_ref());
                }
            }
            Ok(Event::End(e)) => match local(e.name().as_ref()) {
                b"navLabel" => in_label = false,
                b"navPoint" => {
                    if !cur_label.trim().is_empty() && !cur_href.is_empty() {
                        pts.push((
                            cur_play,
                            join_hrefs(&base, &cur_href),
                            cur_label.trim().to_string(),
                        ));
                    }
                    cur_href.clear();
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            _ => {}
        }
    }
    let all_ordered = pts.iter().all(|(p, _, _)| p.is_some());
    let mut order: Vec<usize> = (0..pts.len()).collect();
    if all_ordered {
        order.sort_by_key(|&i| pts[i].0.unwrap());
    }
    order
        .into_iter()
        .map(|i| TocEntry {
            href: pts[i].1.clone(),
            title: pts[i].2.clone(),
        })
        .collect()
}

// ---------- XHTML 内容 → Element ----------

/// 当前累积的块级元素。
enum Block {
    None,
    Heading,
    Para,
}

/// 解析章节 XHTML：h1-h6 → Heading；p/div/li 等 → Paragraph（行内标签文本并入）；
/// img → Image{src=绝对路径}。返回 (元素列表, (Resource, zip 条目名) 列表, 首个标题文本)。
fn parse_xhtml_content(
    xml: &str,
    entry: &str,
    asset_dir: &Path,
    by_entry: &HashMap<String, (String, String)>,
) -> (Vec<Element>, Vec<(Resource, String)>, Option<String>) {
    let mut reader = Reader::from_str(xml);
    let small = |n: &[u8]| as_lower(n);
    let base = entry_dir(entry);
    let mut els: Vec<Element> = Vec::new();
    let mut res: Vec<(Resource, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut first_heading: Option<String> = None;
    let mut block = Block::None;
    let mut buf = String::new();
    let mut skip = 0usize;

    fn flush(
        els: &mut Vec<Element>,
        block: &mut Block,
        buf: &mut String,
        first_heading: &mut Option<String>,
    ) {
        let text = buf.trim().to_string();
        match block {
            Block::Heading => {
                if !text.is_empty() {
                    if first_heading.is_none() {
                        *first_heading = Some(text.clone());
                    }
                    els.push(Element::Heading { text });
                }
            }
            Block::Para => {
                if !text.is_empty() {
                    els.push(Element::Paragraph { text });
                }
            }
            Block::None => {}
        }
        *buf = String::new();
        *block = Block::None;
    }

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let n = small(e.name().as_ref());
                match n.as_str() {
                    "script" | "style" | "head" => skip += 1,
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        flush(&mut els, &mut block, &mut buf, &mut first_heading);
                        block = Block::Heading;
                    }
                    "p" | "div" | "li" | "blockquote" | "td" | "th" | "dd" | "dt"
                    | "figcaption" => {
                        flush(&mut els, &mut block, &mut buf, &mut first_heading);
                        block = Block::Para;
                    }
                    "br" | "hr" => {
                        flush(&mut els, &mut block, &mut buf, &mut first_heading);
                    }
                    "img" => {
                        flush(&mut els, &mut block, &mut buf, &mut first_heading);
                        if let Some(src) = attr(&e, b"src") {
                            push_image(
                                &mut els, &mut res, &mut seen, asset_dir, by_entry, &base, &src,
                            );
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let n = small(e.name().as_ref());
                if n == "br" || n == "hr" {
                    flush(&mut els, &mut block, &mut buf, &mut first_heading);
                } else if n == "img" {
                    flush(&mut els, &mut block, &mut buf, &mut first_heading);
                    if let Some(src) = attr(&e, b"src") {
                        push_image(
                            &mut els, &mut res, &mut seen, asset_dir, by_entry, &base, &src,
                        );
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if skip == 0 {
                    let un = decode_entities(t.as_ref());
                    if !un.trim().is_empty() {
                        if matches!(block, Block::None) {
                            block = Block::Para;
                        }
                        buf.push_str(&un);
                    }
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if skip == 0 {
                    if matches!(block, Block::None) {
                        block = Block::Para;
                    }
                    push_ref(&mut buf, r.as_ref());
                }
            }
            Ok(Event::End(e)) => {
                let n = small(e.name().as_ref());
                match n.as_str() {
                    "script" | "style" | "head" => skip = skip.saturating_sub(1),
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        flush(&mut els, &mut block, &mut buf, &mut first_heading);
                    }
                    "p" | "div" | "li" | "blockquote" | "td" | "th" | "dd" | "dt"
                    | "figcaption" => {
                        flush(&mut els, &mut block, &mut buf, &mut first_heading);
                    }
                    _ => {}
                }
            }
            Ok(Event::CData(c)) => {
                let raw = c.into_inner();
                if skip == 0 && !raw.is_empty() {
                    if matches!(block, Block::None) {
                        block = Block::Para;
                    }
                    buf.push_str(&String::from_utf8_lossy(&raw));
                }
            }
            Ok(Event::Eof) => break,
            _ => {}
        }
    }
    (els, res, first_heading)
}

/// img src → zip 条目（相对章节条目目录解析）→ manifest 匹配 → Resource + Image。
/// 同一图重复引用只登记一次资源。
fn push_image(
    els: &mut Vec<Element>,
    res: &mut Vec<(Resource, String)>,
    seen: &mut HashSet<String>,
    asset_dir: &Path,
    by_entry: &HashMap<String, (String, String)>,
    base: &str,
    src: &str,
) {
    let resolved = strip_fragment(&join_hrefs(base, src));
    let Some((id, mime)) = by_entry.get(&resolved) else {
        eprintln!("[epub] 图片未在 manifest 中声明: {src}");
        return;
    };
    let Some(rel) = safe_rel(&resolved) else {
        eprintln!("[epub] 图片路径含危险段: {src}");
        return;
    };
    let abs = asset_dir.join(&rel);
    let path = abs.display().to_string();
    if seen.insert(resolved.clone()) {
        res.push((
            Resource {
                id: id.clone(),
                mime: mime.clone(),
                path: path.clone(),
            },
            resolved,
        ));
    }
    els.push(Element::Image { src: path });
}

// ---------- 封面 ----------

/// 取 OPF 封面条目落盘为 `{asset_dir}/cover.{ext}`，返回绝对路径。
/// 封面条目缺失或落盘失败返回 None（不影响导入）。
fn cover_path<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    opf: &Opf,
    asset_dir: &Path,
) -> Result<Option<String>, AppError> {
    let Some(id) = &opf.cover_id else { return Ok(None) };
    let Some(item) = opf.manifest.get(id) else {
        eprintln!("[epub] 封面 manifest id 不存在: {id}");
        return Ok(None);
    };
    let Some(bytes) = zip_entry_bytes(zip, &item.entry)? else {
        eprintln!("[epub] 封面条目缺失: {}", item.entry);
        return Ok(None);
    };
    let ext = match item.href.rsplit('.').next() {
        Some(e) if !e.is_empty() && e.len() <= 8 => e.to_string(),
        _ => "img".to_string(),
    };
    let cover_path = asset_dir.join(format!("cover.{ext}"));
    match std::fs::write(&cover_path, &bytes) {
        Ok(_) => Ok(Some(cover_path.display().to_string())),
        Err(e) => {
            eprintln!("[epub] 封面落盘失败 {}: {e}", cover_path.display());
            Ok(None)
        }
    }
}

/// 读取元素的单个属性值。
fn attr(e: &BytesStart, want: &[u8]) -> Option<String> {
    for a in e.attributes() {
        let Ok(a) = a else { continue };
        if local(a.key.as_ref()) == want {
            return Some(String::from_utf8_lossy(&a.value).into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    /// 1x1 透明 PNG（仅作为可落盘的合法图片字节）。
    const PNG_1PX: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    const CONTAINER: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

    #[derive(PartialEq)]
    enum TocKind {
        Ncx,
        Nav,
        None,
    }

    struct Fixture {
        cover_via_meta: bool,
        toc: TocKind,
        chapter_has_h1: bool,
    }

    impl Default for Fixture {
        fn default() -> Self {
            Self {
                cover_via_meta: true,
                toc: TocKind::Ncx,
                chapter_has_h1: true,
            }
        }
    }

    /// 程序化构造最小 EPUB（container + opf + toc + 1 个 xhtml + png + cover 条目）。
    fn build_epub(fx: &Fixture) -> Vec<u8> {
        let cover_item = if fx.cover_via_meta {
            r#"<item id="cover-img" href="images/cover.png" media-type="image/png"/>"#
        } else {
            r#"<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>"#
        };
        let cover_meta = if fx.cover_via_meta {
            r#"<meta name="cover" content="cover-img"/>"#
        } else {
            ""
        };
        let nav_item = match fx.toc {
            TocKind::Ncx => r#"<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>"#,
            TocKind::Nav => r#"<item id="nav" href="text/nav.xhtml" media-type="application/xhtml+xml" properties="navigation"/>"#,
            TocKind::None => "",
        };
        let opf = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title>
    <dc:creator>张三</dc:creator>
    <dc:creator>李四</dc:creator>
    <dc:language>zh-CN</dc:language>
    {cover_meta}
  </metadata>
  <manifest>
    {nav_item}
    <item id="chap1" href="text/chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/pic.png" media-type="image/png"/>
    {cover_item}
  </manifest>
  <spine toc="ncx">
    <itemref idref="chap1"/>
  </spine>
</package>"#
        );
        let heading = if fx.chapter_has_h1 {
            r#"<h1 id="start">第一章 启程</h1>"#
        } else {
            ""
        };
        let chap1 = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>第一章</title><style>body {{ color: red }}</style></head>
  <body>
    {heading}
    <p>第一段<span>行内</span><em>强调</em>内容</p>
    <p>第二段</p>
    <img src="../images/pic.png" alt="插图"/>
  </body>
</html>"#
        );
        let ncx = r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>第一章 启程</text></navLabel>
      <content src="text/chap1.xhtml#start"/>
    </navPoint>
  </navMap>
</ncx>"#;
        let nav = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc">
      <ol><li><a href="chap1.xhtml">第一章 启程</a></li></ol>
    </nav>
  </body>
</html>"#;

        let mut files: Vec<(&str, Vec<u8>)> = Vec::new();
        files.push(("META-INF/container.xml", CONTAINER.as_bytes().to_vec()));
        files.push(("OEBPS/content.opf", opf.as_bytes().to_vec()));
        if fx.toc == TocKind::Ncx {
            files.push(("OEBPS/toc.ncx", ncx.as_bytes().to_vec()));
        }
        if fx.toc == TocKind::Nav {
            files.push(("OEBPS/text/nav.xhtml", nav.as_bytes().to_vec()));
        }
        files.push(("OEBPS/text/chap1.xhtml", chap1.as_bytes().to_vec()));
        files.push(("OEBPS/images/pic.png", PNG_1PX.to_vec()));
        files.push(("OEBPS/images/cover.png", PNG_1PX.to_vec()));

        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            for (name, content) in &files {
                w.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                w.write_all(content).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    fn fixture_file(bytes: &[u8], name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "careader-epub-test-{}-{name}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.epub");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// 解析 fixture，返回 (模型, fixture 目录)；目录由调用方在断言后清理。
    fn parse_fixture(fx: &Fixture, name: &str) -> (DocumentModel, PathBuf) {
        let path = fixture_file(&build_epub(fx), name);
        let model = EpubParser.parse(&path).expect("解析应成功");
        let dir = path.parent().unwrap().to_path_buf();
        (model, dir)
    }

    #[test]
    fn parses_full_epub2_metadata_content_cover() {
        let (model, dir) = parse_fixture(&Fixture::default(), "full");

        assert_eq!(model.format, Format::Epub);
        assert_eq!(model.title, "测试之书");
        assert_eq!(model.authors, vec!["张三".to_string(), "李四".to_string()]);
        assert_eq!(model.language.as_deref(), Some("zh-CN"));

        // 章节数与 id（manifest id 稳定）
        assert_eq!(model.chapters.len(), 1);
        let ch = &model.chapters[0];
        assert_eq!(ch.id, "chap1");
        assert_eq!(ch.title, "第一章 启程"); // ncx label 匹配 href

        // 内容：标题 + 段落（行内标签剥离） + 图片
        assert_eq!(
            ch.content[0],
            Element::Heading { text: "第一章 启程".into() }
        );
        assert_eq!(
            ch.content[1],
            Element::Paragraph { text: "第一段行内强调内容".into() }
        );
        assert_eq!(ch.content[2], Element::Paragraph { text: "第二段".into() });
        let Element::Image { src } = &ch.content[3] else {
            panic!("第 4 个元素应为图片");
        };
        assert!(src.ends_with("OEBPS/images/pic.png"), "src = {src}");

        // 资源：manifest id / mime / 绝对路径，且落盘文件存在
        assert_eq!(ch.resources.len(), 1);
        let r = &ch.resources[0];
        assert_eq!(r.id, "img1");
        assert_eq!(r.mime, "image/png");
        assert_eq!(r.path, *src);
        assert!(Path::new(&r.path).exists(), "图片应已解压: {}", r.path);

        // 封面：绝对路径 + 落盘存在
        let cover = model.cover.expect("封面应命中");
        assert!(cover.ends_with("cover.png"), "cover = {cover}");
        assert!(Path::new(&cover).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cover_via_manifest_properties() {
        let fx = Fixture {
            cover_via_meta: false,
            ..Fixture::default()
        };
        let (model, dir) = parse_fixture(&fx, "props-cover");
        let cover = model.cover.expect("properties=cover-image 应命中封面");
        assert!(cover.ends_with("cover.png"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn epub3_nav_toc_and_title_mapping() {
        let fx = Fixture {
            toc: TocKind::Nav,
            ..Fixture::default()
        };
        let (model, dir) = parse_fixture(&fx, "nav");
        // nav.xhtml 在 OEBPS/text/ 下，href="chap1.xhtml" → 与 spine 条目匹配
        assert_eq!(model.chapters.len(), 1);
        assert_eq!(model.chapters[0].title, "第一章 启程");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn toc_missing_falls_back_to_heading_then_index() {
        // 无 TOC：正文有 h1 → 取 h1 文本
        let fx = Fixture {
            toc: TocKind::None,
            chapter_has_h1: true,
            ..Fixture::default()
        };
        let (model, dir) = parse_fixture(&fx, "no-toc-h1");
        assert_eq!(model.chapters[0].title, "第一章 启程");
        std::fs::remove_dir_all(&dir).ok();

        // 无 TOC 且无 h1 → 第 N 章
        let fx = Fixture {
            toc: TocKind::None,
            chapter_has_h1: false,
            ..Fixture::default()
        };
        let (model, dir) = parse_fixture(&fx, "no-toc-no-h1");
        assert_eq!(model.chapters[0].title, "第 1 章");
        assert!(model.chapters[0]
            .content
            .contains(&Element::Paragraph { text: "第二段".into() }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_container_is_parse_failed() {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            w.start_file("OEBPS/content.opf", zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(b"<package/>").unwrap();
            w.finish().unwrap();
        }
        let path = fixture_file(&buf.into_inner(), "no-container");
        let err = EpubParser.parse(&path).err().expect("应解析失败");
        assert!(matches!(err, AppError::ParseFailed(_)));
        assert!(err.to_string().contains("container.xml"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn safe_rel_rejects_traversal() {
        assert_eq!(safe_rel("OEBPS/images/a.png").unwrap(), "OEBPS/images/a.png");
        assert!(safe_rel("../escape.png").is_none());
        assert!(safe_rel("../../etc/passwd").is_none());
        assert!(safe_rel("/abs/x.png").is_some()); // 前导斜杠被相对化
        assert_eq!(safe_rel("./a/./b.png").unwrap(), "a/b.png");
    }
}