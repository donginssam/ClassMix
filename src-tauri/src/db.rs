//! 작업 파일(.mix = SQLite) 생성·열기·마이그레이션.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, Transaction, config::DbConfig, params};
use sha2::{Digest, Sha256};

use crate::crypto::Codec;
use crate::error::{AppError, AppResult};
use crate::paths::{StagedFile, ensure_local_volume, resolve_parent};

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

/// 작업 파일의 마지막 수정 시각(`meta.updated_at`)을 `at`으로 바꾼다.
pub fn touch(conn: &Connection, at: &str) -> AppResult<()> {
    conn.execute("UPDATE meta SET updated_at = ?1 WHERE id = 1", params![at])?;
    Ok(())
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // 지우거나 덮어쓴 레코드 자리를 0으로 채워, 파일 안에 이전 값(평문)이 남지 않게 한다.
    conn.pragma_update(None, "secure_delete", "ON")?;
    // 단일 파일 유지: WAL 대신 롤백 저널(DELETE)을 쓴다.
    let _mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
    conn.busy_timeout(std::time::Duration::from_secs(3))?;
    Ok(())
}

fn harden(conn: &Connection) -> AppResult<()> {
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    Ok(())
}

/// 현재 스키마 버전의 객체와 DDL만 허용한다. 앱 ID와 버전은 파일 형식 표시다.
pub fn validate_schema(conn: &Connection) -> AppResult<()> {
    validate_schema_at(conn, SCHEMA_VERSION)
}

/// `version` 스키마의 객체와 DDL만 허용한다. 마이그레이션 전 파일은 그 파일 버전으로 검사한다.
fn validate_schema_at(conn: &Connection, version: i32) -> AppResult<()> {
    let steps = usize::try_from(version - 1)
        .ok()
        .and_then(|steps| MIGRATIONS.get(..steps))
        .ok_or_else(unsupported_schema)?;
    compare_schema(conn, &reference_schema(steps)?)
}

/// v1 스키마에 마이그레이션을 차례로 적용해, 그 버전에서 앱이 만드는 스키마를 그대로 재현한다.
fn reference_schema(migrations: &[&str]) -> AppResult<Connection> {
    let reference = Connection::open_in_memory()?;
    reference.execute_batch(SCHEMA_V1)?;
    for sql in migrations {
        reference.execute_batch(sql)?;
    }
    Ok(reference)
}

fn compare_schema(conn: &Connection, reference: &Connection) -> AppResult<()> {
    const OBJECTS: &str =
        "SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name";
    let mut actual = conn.prepare(OBJECTS)?;
    let mut expected = reference.prepare(OBJECTS)?;
    let (mut actual, mut expected) = (actual.query([])?, expected.query([])?);
    loop {
        match (actual.next()?, expected.next()?) {
            (None, None) => return Ok(()),
            (Some(actual), Some(expected)) => {
                for index in 0..4 {
                    if actual.get_ref(index)? != expected.get_ref(index)? {
                        return Err(unsupported_schema());
                    }
                }
            }
            _ => return Err(unsupported_schema()),
        }
    }
}

fn unsupported_schema() -> AppError {
    AppError::InvalidInput(
        "ClassMix가 지원하는 작업 파일 구조와 다릅니다. 원본 파일을 확인해 주세요.".into(),
    )
}

fn open_connection(path: &Path, flags: OpenFlags) -> AppResult<Connection> {
    let conn = Connection::open_with_flags(
        resolve_parent(path)?,
        flags | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    harden(&conn)?;
    Ok(conn)
}

pub fn empty_database(staged: &StagedFile) -> AppResult<Connection> {
    staged.reopen()?;
    let conn = open_connection(staged.path(), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    staged.reopen()?;
    configure(&conn)?;
    conn.execute_batch(SCHEMA_V1)?;
    conn.pragma_update(None, "application_id", APPLICATION_ID)?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(conn)
}

/// 새 작업 파일을 만든다. 같은 경로에 파일이 있으면(저장 대화상자에서 덮어쓰기 확인을 받은 경우)
/// 새 파일을 다 만든 뒤에 바꿔 넣으므로, 만들다 실패해도 기존 파일은 그대로 남는다.
pub fn create_new(path: &Path, title: &str) -> AppResult<Connection> {
    ensure_local_volume(path)?;
    let staged = StagedFile::new(path)?;
    {
        let conn = empty_database(&staged)?;
        let ts = now();
        conn.execute(
            "INSERT INTO meta (id, title, app_version, created_at, updated_at) VALUES (1, ?1, ?2, ?3, ?3)",
            params![title, env!("APP_VERSION"), ts],
        )?;
    }
    staged.publish()?;
    Ok(open_existing(path)?.0)
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
    ensure_local_volume(path)?;
    let conn = open_connection(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let (app_id, version) = read_header(&conn)?;
    if app_id != APPLICATION_ID || version < 1 {
        return Err(AppError::NotClassMixFile);
    }
    let mut outcome = OpenOutcome::default();
    if version > SCHEMA_VERSION {
        drop(conn);
        let conn = open_connection(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        if read_header(&conn)? != (app_id, version) {
            return Err(AppError::NotClassMixFile);
        }
        validate_schema(&conn).map_err(|_| {
            AppError::InvalidInput("이 작업 파일을 열려면 ClassMix를 업데이트해 주세요.".into())
        })?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        outcome.read_only = true;
        outcome.newer_version = true;
        return Ok((conn, outcome));
    }

    // 이전 버전 파일은 그 버전의 스키마로 검사한 뒤 마이그레이션하고, 결과를 현재 스키마로 다시 검사한다.
    validate_schema_at(&conn, version)?;
    configure(&conn)?;
    if version < SCHEMA_VERSION {
        let backup = backup_path_for(path);
        std::fs::copy(path, &backup)?;
        outcome.backup_path = Some(backup);
        migrate(&conn, version)?;
        validate_schema(&conn)?;
    }
    // 예전 버전이 남긴 열림 표시(PC 이름)를 지운다. 값이 있을 때만 써서, 열기만으로 파일이 바뀌지 않게 한다.
    conn.execute(
        "UPDATE meta SET opened_by = NULL, opened_at = NULL \
         WHERE id = 1 AND (opened_by IS NOT NULL OR opened_at IS NOT NULL)",
        [],
    )?;
    Ok((conn, outcome))
}

fn migrate(conn: &Connection, from: i32) -> AppResult<()> {
    for v in from..SCHEMA_VERSION {
        let sql = MIGRATIONS.get((v - 1) as usize).ok_or_else(|| {
            AppError::Other(format!("v{v} → v{} 마이그레이션이 없습니다.", v + 1))
        })?;
        // 단계마다 한 트랜잭션: 실패하면(커밋 전 drop) 그 단계는 통째로 되돌아간다.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", v + 1)?;
        tx.commit()?;
    }
    Ok(())
}

/// 다음에 넣을 행 id. 암호화한 칸은 행 id를 AAD에 묶으므로, 넣기 전에 id를 정해 둔다.
/// 같은 연결·트랜잭션 안에서 넣기 바로 직전에 부른다.
pub fn next_id(conn: &Connection, table: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        &format!("SELECT COALESCE(MAX(id), 0) + 1 FROM {table}"),
        [],
        |r| r.get(0),
    )?)
}

/// 가져온 파일의 원본과 해시를 같은 트랜잭션에서 저장한다.
pub fn insert_source_file(
    tx: &Transaction<'_>,
    codec: Codec,
    kind: &str,
    file_name: &str,
    bytes: &[u8],
    imported_at: &str,
) -> AppResult<()> {
    let id = next_id(tx, "source_file")?;
    let sha256: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    tx.execute(
        "INSERT INTO source_file (id, kind, file_name, sha256, content, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, kind, file_name, sha256, codec.blob("source_file.content", id, bytes)?, imported_at],
    )?;
    Ok(())
}

/// 일관된 단일 파일 사본을 만든다(`VACUUM INTO`). 예전 버전의 열림 표시(PC 이름)는 사본에 남기지 않는다.
/// 임시 파일에 다 만든 뒤 바꿔 넣으므로, 실패해도 대상 위치의 기존 파일은 그대로 남는다.
pub fn vacuum_into(conn: &Connection, target: &Path) -> AppResult<()> {
    ensure_local_volume(target)?;
    validate_schema(conn)?;
    let staged = StagedFile::new(target)?;
    {
        let tmp_str = staged
            .path()
            .to_str()
            .ok_or_else(|| AppError::InvalidInput("경로에 쓸 수 없는 문자가 있습니다.".into()))?;
        staged.reopen()?;
        conn.execute("VACUUM INTO ?1", params![tmp_str])?;
        staged.reopen()?;
        let copy = open_connection(staged.path(), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        validate_schema(&copy)?;
        copy.execute(
            "UPDATE meta SET opened_by = NULL, opened_at = NULL WHERE id = 1",
            [],
        )?;
    }
    staged.publish()
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
    fn opening_clears_legacy_open_marker_without_touching_clean_files() {
        let dir = tmp();
        let path = dir.path().join("예전 표시.mix");
        drop(create_new(&path, "예전 표시").unwrap());
        // 표시가 없는 파일은 열기만으로 바뀌지 않는다.
        let before = std::fs::read(&path).unwrap();
        drop(open_existing(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        // 예전 버전이 남긴 PC 이름은 쓰기 가능하게 열 때 지운다.
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE meta SET opened_by = '김OO의 PC', opened_at = 'x' WHERE id = 1",
                [],
            )
            .unwrap();
        let (conn, _) = open_existing(&path).unwrap();
        let marker: (Option<String>, Option<String>) = conn
            .query_row("SELECT opened_by, opened_at FROM meta", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(marker, (None, None));
    }

    #[test]
    fn schema_is_checked_against_the_files_own_version() {
        // 가상의 v1 → v2 마이그레이션으로, 버전마다 다른 기준 스키마를 쓰는지 확인한다.
        const ADD_COLUMN: &str = "ALTER TABLE student ADD COLUMN extra TEXT;";
        let dir = tmp();
        let conn = create_new(&dir.path().join("v1.mix"), "v1").unwrap();
        let v1 = reference_schema(&[]).unwrap();
        let v2 = reference_schema(&[ADD_COLUMN]).unwrap();
        assert!(compare_schema(&conn, &v1).is_ok());
        assert!(
            compare_schema(&conn, &v2).is_err(),
            "마이그레이션 전 파일은 v2와 다르다"
        );
        conn.execute_batch(ADD_COLUMN).unwrap();
        assert!(
            compare_schema(&conn, &v2).is_ok(),
            "마이그레이션한 파일은 v2와 같다"
        );
        assert!(compare_schema(&conn, &v1).is_err());
        // 마이그레이션이 없는 버전은 기준을 만들 수 없으므로 거부한다.
        assert!(validate_schema_at(&conn, SCHEMA_VERSION + 1).is_err());
        assert!(validate_schema_at(&conn, 0).is_err());
    }

    #[test]
    fn rejects_unsupported_schema_objects_and_definitions() {
        let dir = tmp();
        let path = dir.path().join("작업.mix");
        {
            let conn = create_new(&path, "작업").unwrap();
            conn.execute_batch("CREATE TABLE extra_notes (id INTEGER PRIMARY KEY);")
                .unwrap();
        }
        assert!(open_existing(&path).is_err());

        let changed_index = dir.path().join("다른 구조.mix");
        {
            let conn = create_new(&changed_index, "작업").unwrap();
            conn.execute_batch(
                "DROP INDEX idx_student_class; CREATE INDEX idx_student_class ON student(id);",
            )
            .unwrap();
        }
        assert!(open_existing(&changed_index).is_err());
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

    // ───── 새 파일·사본은 다 만든 뒤 바꿔 넣는다 ─────

    fn only_files(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn create_new_replaces_an_existing_file_and_leaves_no_temp_files() {
        let dir = tmp();
        let p = dir.path().join("덮어쓰기.mix");
        std::fs::write(&p, "이전 내용").unwrap();
        // 기존 임시 파일 이름에 있는 다른 파일에는 손대지 않는다.
        let other = dir.path().join("덮어쓰기.mix.classmix-tmp");
        std::fs::write(&other, "기존 파일").unwrap();
        let conn = create_new(&p, "새 파일").unwrap();
        let (app_id, version): (i32, i32) = (
            conn.query_row("PRAGMA application_id", [], |r| r.get(0))
                .unwrap(),
            conn.query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap(),
        );
        assert_eq!((app_id, version), (APPLICATION_ID, SCHEMA_VERSION));
        drop(conn);
        assert_eq!(std::fs::read_to_string(other).unwrap(), "기존 파일");
        assert_eq!(
            only_files(dir.path()),
            ["덮어쓰기.mix", "덮어쓰기.mix.classmix-tmp"]
        );
        assert!(open_existing(&p).is_ok());
    }

    #[cfg(unix)]
    fn with_read_only_dir(dir: &Path, f: impl FnOnce()) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        if let Err(e) = r {
            std::panic::resume_unwind(e);
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_create_new_keeps_the_existing_file() {
        let dir = tmp();
        let p = dir.path().join("기존.mix");
        std::fs::write(&p, "지우면 안 되는 기존 파일").unwrap();
        with_read_only_dir(dir.path(), || {
            assert!(create_new(&p, "x").is_err());
        });
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "지우면 안 되는 기존 파일"
        );
        assert_eq!(only_files(dir.path()), vec!["기존.mix".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn failed_copy_keeps_the_existing_target() {
        let dir = tmp();
        let src = create_new(&dir.path().join("원본.mix"), "원본").unwrap();
        let out = dir.path().join("사본 폴더");
        std::fs::create_dir(&out).unwrap();
        let target = out.join("사본.mix");
        std::fs::write(&target, "예전 사본").unwrap();
        with_read_only_dir(&out, || {
            assert!(vacuum_into(&src, &target).is_err());
        });
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "예전 사본");
        assert_eq!(only_files(&out), vec!["사본.mix".to_string()]);
    }

    #[test]
    fn copy_replaces_target_atomically_without_the_opened_by_mark() {
        let dir = tmp();
        let src = create_new(&dir.path().join("원본.mix"), "원본").unwrap();
        src.execute("UPDATE meta SET opened_by = 'PC-1', opened_at = 'x'", [])
            .unwrap();
        let target = dir.path().join("사본.mix");
        std::fs::write(&target, "예전 사본").unwrap();
        vacuum_into(&src, &target).unwrap();
        let (copy, _) = open_existing(&target).unwrap();
        let by: Option<String> = copy
            .query_row("SELECT opened_by FROM meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(by, None, "사본에는 열림 표시가 없어야 함");
        let src_by: Option<String> = src
            .query_row("SELECT opened_by FROM meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(src_by.as_deref(), Some("PC-1"), "원본은 그대로");
        assert_eq!(only_files(dir.path()), ["사본.mix", "원본.mix"]);
    }

    #[test]
    fn copy_that_fails_midway_keeps_the_existing_target() {
        // 대상 폴더는 쓸 수 있는데 복사가 실패하는 경우(예전 코드는 이때 기존 파일을 먼저 지웠다)
        let dir = tmp();
        let src = create_new(&dir.path().join("원본.mix"), "원본").unwrap();
        let target = dir.path().join("사본.mix");
        std::fs::write(&target, "예전 사본").unwrap();
        src.execute_batch("BEGIN").unwrap(); // 트랜잭션 안에서는 VACUUM INTO가 실패한다
        assert!(vacuum_into(&src, &target).is_err());
        src.execute_batch("ROLLBACK").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "예전 사본");
        assert_eq!(only_files(dir.path()), ["사본.mix", "원본.mix"]);
    }
}
