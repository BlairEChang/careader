//! SQLite 持久化（docs/architecture.md §5.2）：连接管理、版本化迁移、
//! 全部实体的 CRUD 查询。command 层保持薄封装。

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::error::AppError;
use crate::model::document::Format;
use crate::model::entities::{Annotation, Book, NewAnnotation, Progress};

const SCHEMA_V1: &str = r#"
CREATE TABLE books (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    authors       TEXT NOT NULL DEFAULT '',
    format        TEXT NOT NULL,
    file_path     TEXT NOT NULL UNIQUE,
    cover_path    TEXT,
    added_at      INTEGER NOT NULL,
    last_opened_at INTEGER
);

CREATE TABLE progress (
    book_id       INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    chapter_idx   INTEGER NOT NULL DEFAULT 0,
    char_offset   INTEGER NOT NULL DEFAULT 0,
    percent       REAL NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE annotations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    chapter_idx   INTEGER NOT NULL,
    start         INTEGER NOT NULL,
    end           INTEGER NOT NULL,
    text          TEXT,
    note_body     TEXT,
    color         TEXT NOT NULL DEFAULT 'yellow',
    page          INTEGER,
    created_at    INTEGER NOT NULL
);
CREATE INDEX idx_annotations_book ON annotations(book_id, chapter_idx);

CREATE TABLE settings (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL
);
"#;

const MIGRATIONS: [&str; 1] = [SCHEMA_V1];

/// 打开（或创建）数据库并执行未应用的迁移。
pub fn open(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut conn = Connection::open(db_path)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> Result<(), AppError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, script) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        conn.execute_batch(script)?;
        conn.pragma_update(None, "user_version", i as i64 + 1)?;
    }
    Ok(())
}

fn authors_from_json(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

impl Book {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let authors_raw: String = row.get("authors")?;
        Ok(Book {
            id: row.get("id")?,
            title: row.get("title")?,
            authors: authors_from_json(&authors_raw),
            format: parse_format(&row.get::<_, String>("format")?),
            file_path: row.get("file_path")?,
            cover_path: row.get("cover_path")?,
            added_at: row.get("added_at")?,
            last_opened_at: row.get("last_opened_at")?,
        })
    }
}

fn parse_format(raw: &str) -> Format {
    match raw {
        "epub" => Format::Epub,
        "mobi" => Format::Mobi,
        "txt" => Format::PlainText,
        "md" => Format::Markdown,
        "pdf" => Format::Pdf,
        _ => Format::PlainText,
    }
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- books ----------

pub fn insert_book(
    conn: &Connection,
    book: &Book,
) -> Result<i64, AppError> {
    conn.execute(
        "INSERT INTO books (title, authors, format, file_path, added_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            book.title,
            serde_json::to_string(&book.authors).unwrap_or_else(|_| "[]".to_string()),
            book.format.to_string(),
            book.file_path,
            book.added_at,
            book.last_opened_at,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_books(conn: &Connection) -> Result<Vec<Book>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM books ORDER BY added_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], Book::from_row)?;
    let mut books = Vec::new();
    for row in rows {
        books.push(row?);
    }
    Ok(books)
}

pub fn get_book(conn: &Connection, id: i64) -> Result<Option<Book>, AppError> {
    let mut stmt = conn.prepare("SELECT * FROM books WHERE id = ?1")?;
    let book = stmt
        .query_row(params![id], Book::from_row)
        .optional()?;
    Ok(book)
}

pub fn delete_book(conn: &Connection, id: i64) -> Result<Book, AppError> {
    let book = get_book(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("book #{id}")))?;
    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;
    Ok(book)
}

pub fn touch_book(conn: &Connection, id: i64) -> Result<(), AppError> {
    conn.execute(
        "UPDATE books SET last_opened_at = ?1 WHERE id = ?2",
        params![now_secs(), id],
    )?;
    Ok(())
}

// ---------- progress ----------

pub fn get_progress(conn: &Connection, book_id: i64) -> Result<Option<Progress>, AppError> {
    let mut stmt = conn.prepare("SELECT * FROM progress WHERE book_id = ?1")?;
    let row = stmt
        .query_row(params![book_id], |r| {
            Ok(Progress {
                book_id: r.get("book_id")?,
                chapter_idx: r.get("chapter_idx")?,
                char_offset: r.get("char_offset")?,
                percent: r.get("percent")?,
                updated_at: r.get("updated_at")?,
            })
        })
        .optional()?;
    Ok(row)
}

pub fn list_progress(conn: &Connection) -> Result<Vec<Progress>, AppError> {
    let mut stmt = conn.prepare("SELECT * FROM progress ORDER BY book_id")?;
    let rows = stmt.query_map([], |r| {
        Ok(Progress {
            book_id: r.get("book_id")?,
            chapter_idx: r.get("chapter_idx")?,
            char_offset: r.get("char_offset")?,
            percent: r.get("percent")?,
            updated_at: r.get("updated_at")?,
        })
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(items)
}

pub fn upsert_progress(
    conn: &Connection,
    book_id: i64,
    chapter_idx: i64,
    char_offset: i64,
    percent: f64,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO progress (book_id, chapter_idx, char_offset, percent, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book_id) DO UPDATE SET
           chapter_idx = excluded.chapter_idx,
           char_offset = excluded.char_offset,
           percent = excluded.percent,
           updated_at = excluded.updated_at",
        params![book_id, chapter_idx, char_offset, percent, now_secs()],
    )?;
    Ok(())
}

// ---------- annotations ----------

impl Annotation {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Annotation {
            id: row.get("id")?,
            book_id: row.get("book_id")?,
            kind: row.get("kind")?,
            chapter_idx: row.get("chapter_idx")?,
            start: row.get("start")?,
            end: row.get("end")?,
            text: row.get("text")?,
            note_body: row.get("note_body")?,
            color: row.get("color")?,
            page: row.get("page")?,
            created_at: row.get("created_at")?,
        })
    }
}

/// 插入标注，返回新行 id（created_at 在此生成）。
pub fn insert_annotation(conn: &Connection, new: &NewAnnotation) -> Result<i64, AppError> {
    conn.execute(
        "INSERT INTO annotations (book_id, kind, chapter_idx, start, end, text, color, page, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            new.book_id,
            new.kind,
            new.chapter_idx,
            new.start,
            new.end,
            new.text,
            new.color,
            new.page,
            now_secs(),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_annotation(conn: &Connection, id: i64) -> Result<Option<Annotation>, AppError> {
    let mut stmt = conn.prepare("SELECT * FROM annotations WHERE id = ?1")?;
    let ann = stmt
        .query_row(params![id], Annotation::from_row)
        .optional()?;
    Ok(ann)
}

/// 整书标注，按章节/起始位置排序（NotesPanel 展示顺序与后续定位友好）。
pub fn list_annotations(conn: &Connection, book_id: i64) -> Result<Vec<Annotation>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM annotations WHERE book_id = ?1 ORDER BY chapter_idx, start, id",
    )?;
    let rows = stmt.query_map(params![book_id], Annotation::from_row)?;
    let mut anns = Vec::new();
    for row in rows {
        anns.push(row?);
    }
    Ok(anns)
}

/// 部分更新（note_body / color 至少一项）；kind 不可改。返回更新后的完整行。
pub fn update_annotation(
    conn: &Connection,
    id: i64,
    note_body: Option<&str>,
    color: Option<&str>,
) -> Result<Annotation, AppError> {
    get_annotation(conn, id)?.ok_or_else(|| AppError::NotFound(format!("annotation #{id}")))?;
    match (note_body, color) {
        (Some(note), Some(color)) => {
            conn.execute(
                "UPDATE annotations SET note_body = ?1, color = ?2 WHERE id = ?3",
                params![note, color, id],
            )?;
        }
        (Some(note), None) => {
            conn.execute(
                "UPDATE annotations SET note_body = ?1 WHERE id = ?2",
                params![note, id],
            )?;
        }
        (None, Some(color)) => {
            conn.execute(
                "UPDATE annotations SET color = ?1 WHERE id = ?2",
                params![color, id],
            )?;
        }
        (None, None) => {} // 调用方（command 层）已校验至少一项
    }
    Ok(get_annotation(conn, id)?.expect("updated annotation must exist"))
}

/// 删除标注；记录不存在返回 NotFound。
pub fn delete_annotation(conn: &Connection, id: i64) -> Result<(), AppError> {
    let n = conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("annotation #{id}")));
    }
    Ok(())
}

// ---------- settings ----------

pub fn get_settings(conn: &Connection) -> Result<std::collections::HashMap<String, serde_json::Value>, AppError> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>("key")?, r.get::<_, String>("value")?))
    })?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (key, value) = row?;
        if let Ok(json) = serde_json::from_str(&value) {
            map.insert(key, json);
        }
    }
    Ok(map)
}

pub fn set_setting(conn: &Connection, key: &str, value: serde_json::Value) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!(
            "careader-test-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let conn = open(&dir.join("careader.db")).unwrap();
        (dir, conn)
    }

    #[test]
    fn migration_is_idempotent() {
        let (dir, conn) = temp_db("migrate");
        drop(conn);
        let conn2 = open(&dir.join("careader.db")).unwrap();
        let tables: Vec<String> = conn2
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(tables.contains(&"books".to_string()));
        assert!(tables.contains(&"progress".to_string()));
        assert!(tables.contains(&"annotations".to_string()));
        assert!(tables.contains(&"settings".to_string()));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn book_and_progress_roundtrip() {
        let (dir, conn) = temp_db("crud");
        let book = Book {
            id: 0,
            title: "测试书".into(),
            authors: vec!["作者甲".into(), "乙".into()],
            format: Format::PlainText,
            file_path: "/tmp/x.txt".into(),
            cover_path: None,
            added_at: now_secs(),
            last_opened_at: None,
        };
        let id = insert_book(&conn, &book).unwrap();
        let loaded = get_book(&conn, id).unwrap().unwrap();
        assert_eq!(loaded.title, "测试书");
        assert_eq!(loaded.authors, vec!["作者甲".to_string(), "乙".to_string()]);
        assert_eq!(loaded.format, Format::PlainText);

        upsert_progress(&conn, id, 2, 100, 0.42).unwrap();
        let p = get_progress(&conn, id).unwrap().unwrap();
        assert_eq!(p.chapter_idx, 2);
        assert_eq!(p.char_offset, 100);
        upsert_progress(&conn, id, 3, 0, 0.55).unwrap(); // 再写覆盖
        let p = get_progress(&conn, id).unwrap().unwrap();
        assert_eq!(p.chapter_idx, 3);
        assert!((p.percent - 0.55).abs() < 1e-9);

        let listed = list_books(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        let removed = delete_book(&conn, id).unwrap();
        assert_eq!(removed.title, "测试书");
        assert!(delete_book(&conn, id).is_err()); // 已删除
        assert!(get_progress(&conn, id).unwrap().is_none()); // 级联清理
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn annotation_roundtrip() {
        let (dir, conn) = temp_db("annotations");
        let book = Book {
            id: 0,
            title: "测试书".into(),
            authors: vec![],
            format: Format::PlainText,
            file_path: "/tmp/x.txt".into(),
            cover_path: None,
            added_at: now_secs(),
            last_opened_at: None,
        };
        let book_id = insert_book(&conn, &book).unwrap();

        let hl = NewAnnotation {
            book_id,
            kind: "highlight".into(),
            chapter_idx: 1,
            start: 10,
            end: 20,
            text: Some("高亮原文快照".into()),
            color: "yellow".into(),
            page: None,
        };
        let hl_id = insert_annotation(&conn, &hl).unwrap();
        let bm = NewAnnotation {
            book_id,
            kind: "bookmark".into(),
            chapter_idx: 0,
            start: 0,
            end: 0,
            text: None,
            color: "yellow".into(),
            page: None,
        };
        let bm_id = insert_annotation(&conn, &bm).unwrap();

        // 排序：chapter_idx, start
        let listed = list_annotations(&conn, book_id).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, bm_id);
        assert_eq!(listed[0].kind, "bookmark");
        assert_eq!(listed[1].kind, "highlight");
        assert_eq!(listed[1].text.as_deref(), Some("高亮原文快照"));
        assert!(listed[1].page.is_none());

        // 只改 note_body，color 保持
        let up = update_annotation(&conn, hl_id, Some("我的笔记"), None).unwrap();
        assert_eq!(up.note_body.as_deref(), Some("我的笔记"));
        assert_eq!(up.color, "yellow");
        // 只改 color，note_body 保持
        let up = update_annotation(&conn, hl_id, None, Some("green")).unwrap();
        assert_eq!(up.color, "green");
        assert_eq!(up.note_body.as_deref(), Some("我的笔记"));

        // 删除 + 书籍级联
        delete_annotation(&conn, hl_id).unwrap();
        assert!(get_annotation(&conn, hl_id).unwrap().is_none());
        assert!(update_annotation(&conn, hl_id, Some("x"), None).is_err()); // 已删除
        delete_book(&conn, book_id).unwrap();
        assert!(list_annotations(&conn, book_id).unwrap().is_empty());
        assert!(delete_annotation(&conn, bm_id).is_err()); // 级联已清

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn settings_roundtrip() {
        let (dir, conn) = temp_db("settings");
        set_setting(&conn, "theme", serde_json::json!("sepia")).unwrap();
        set_setting(&conn, "fontSize", serde_json::json!(18.0)).unwrap();
        set_setting(&conn, "theme", serde_json::json!("dark")).unwrap(); // 覆盖
        let all = get_settings(&conn).unwrap();
        assert_eq!(all.get("theme"), Some(&serde_json::json!("dark")));
        assert_eq!(all.get("fontSize"), Some(&serde_json::json!(18.0)));
        std::fs::remove_dir_all(dir).ok();
    }
}
