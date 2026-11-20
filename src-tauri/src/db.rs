//! 작업 파일(.mix = SQLite) 생성·열기·마이그레이션.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, params};

use crate::error::{AppError, AppResult};

/// `PRAGMA application_id` 값. ASCII 'CMIX'.
pub const APPLICATION_ID: i32 = 0x434D_4958;
/// 현재 스키마 버전(`PRAGMA user_version`).
pub const SCHEMA_VERSION: i32 = 1;
pub const FILE_EXTENSION: &str = "mix";

const SCHEMA_V1: &str = include_str!("schema_v1.sql");

/// 버전 n → n+1 로 올리는 마이그레이션. 인덱스 0 이 v1 → v2.
const MIGRATIONS: &[&str] = &[];

pub fn now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // 단일 파일 유지: WAL 대신 롤백 저널(DELETE)을 쓴다.
    let _mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
    conn.busy_timeout(std::time::Duration::from_secs(3))?;
    Ok(())
}

/// 새 작업 파일을 만든다. 같은 경로에 파일이 있으면 지우고 새로 만든다(저장 대화상자에서 덮어쓰기 확인을 받은 경우).
pub fn create_new(path: &Path, title: &str) -> AppResult<Connection> {
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    configure(&conn)?;
    conn.pragma_update(None, "application_id", APPLICATION_ID)?;
    conn.execute_batch(SCHEMA_V1)?;
    let ts = now();
    conn.execute(
        "INSERT INTO meta (id, title, app_version, created_at, updated_at) VALUES (1, ?1, ?2, ?3, ?3)",
        params![title, env!("APP_VERSION"), ts],
    )?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(conn)
}

#[derive(Debug, Default)]
pub struct OpenOutcome {
    pub read_only: bool,
    /// 마이그레이션 전에 만든 백업 사본 경로
    pub backup_path: Option<PathBuf>,
    pub newer_version: bool,
}

fn read_header(conn: &Connection) -> AppResult<(i32, i32)> {
    let app_id: i32 = conn
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(|_| AppError::NotClassMixFile)?;
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| AppError::NotClassMixFile)?;
    Ok((app_id, version))
}

/// `<이름>.bak.mix` (이미 있으면 `<이름>.bak2.mix` …)
pub fn backup_path_for(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("classmix");
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut candidate = dir.join(format!("{stem}.bak.{FILE_EXTENSION}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}.bak{n}.{FILE_EXTENSION}"));
        n += 1;
    }
    candidate
}

/// 기존 작업 파일을 연다. ClassMix 파일이 아니면 거절하고, 이전 버전이면 백업 후 마이그레이션,
/// 앱보다 새 버전이면 읽기 전용으로 연다.
pub fn open_existing(path: &Path) -> AppResult<(Connection, OpenOutcome)> {
    if !path.is_file() {
        return Err(AppError::Other(format!(
            "파일을 찾을 수 없습니다: {}",
            path.display()
        )));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let (app_id, version) = read_header(&conn)?;
    if app_id != APPLICATION_ID || version < 1 {
        return Err(AppError::NotClassMixFile);
    }

    let mut outcome = OpenOutcome::default();
    if version > SCHEMA_VERSION {
        drop(conn);
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        outcome.read_only = true;
        outcome.newer_version = true;
        return Ok((conn, outcome));
    }

    configure(&conn)?;
    if version < SCHEMA_VERSION {
        let backup = backup_path_for(path);
        std::fs::copy(path, &backup)?;
        outcome.backup_path = Some(backup);
        migrate(&conn, version)?;
    }
    Ok((conn, outcome))
}

fn migrate(conn: &Connection, from: i32) -> AppResult<()> {
    for v in from..SCHEMA_VERSION {
        let sql = MIGRATIONS.get((v - 1) as usize).ok_or_else(|| {
            AppError::Other(format!("v{v} → v{} 마이그레이션이 없습니다.", v + 1))
        })?;
        conn.execute_batch(&format!(
            "BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;",
            v + 1
        ))?;
    }
    Ok(())
}

/// 일관된 단일 파일 사본을 만든다(`VACUUM INTO`).
pub fn vacuum_into(conn: &Connection, target: &Path) -> AppResult<()> {
    if target.exists() {
        std::fs::remove_file(target)?;
    }
    let target_str = target
        .to_str()
        .ok_or_else(|| AppError::InvalidInput("경로에 쓸 수 없는 문자가 있습니다.".into()))?;
    conn.execute("VACUUM INTO ?1", params![target_str])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn create_then_reopen() {
        let dir = tmp();
        let p = dir.path().join("작업 파일.mix");
        {
            let _conn = create_new(&p, "테스트").unwrap();
        }
        let (conn, outcome) = open_existing(&p).unwrap();
        assert!(!outcome.read_only);
        let title: String = conn
            .query_row("SELECT title FROM meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "테스트");
        // 단일 파일 유지
        assert!(!dir.path().join("작업 파일.mix-wal").exists());
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "delete");
    }

    #[test]
    fn rejects_other_sqlite_and_non_sqlite_files() {
        let dir = tmp();
        let other = dir.path().join("other.db");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE t(x);")
            .unwrap();
        assert!(matches!(
            open_existing(&other),
            Err(AppError::NotClassMixFile)
        ));

        let text = dir.path().join("text.mix");
        std::fs::write(
            &text,
            "hello, this is not sqlite at all .......................",
        )
        .unwrap();
        assert!(matches!(
            open_existing(&text),
            Err(AppError::NotClassMixFile)
        ));
    }

    #[test]
    fn newer_version_opens_read_only() {
        let dir = tmp();
        let p = dir.path().join("new.mix");
        {
            let conn = create_new(&p, "x").unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 5)
                .unwrap();
        }
        let (conn, outcome) = open_existing(&p).unwrap();
        assert!(outcome.read_only && outcome.newer_version);
        assert!(conn.execute("UPDATE meta SET title='y'", []).is_err());
    }

    #[test]
    fn vacuum_into_makes_openable_copy() {
        let dir = tmp();
        let p = dir.path().join("a.mix");
        let copy = dir.path().join("b.mix");
        let conn = create_new(&p, "원본").unwrap();
        vacuum_into(&conn, &copy).unwrap();
        let (c2, _) = open_existing(&copy).unwrap();
        let title: String = c2
            .query_row("SELECT title FROM meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "원본");
    }

    #[test]
    fn backup_path_does_not_overwrite() {
        let dir = tmp();
        let p = dir.path().join("x.mix");
        std::fs::write(dir.path().join("x.bak.mix"), "").unwrap();
        assert_eq!(backup_path_for(&p), dir.path().join("x.bak2.mix"));
    }
}
