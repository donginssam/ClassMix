//! 여러 모듈의 테스트가 함께 쓰는 샘플 작업 파일 준비 도우미.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::crypto::PLAIN;
use crate::xlsx_import::{apply_import, parse_roster, plan_import};

/// 저장소에 들어 있는 샘플 나이스 XLSX(학생 240명)
pub fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sample.xlsx")
}

/// 빈 작업 파일에 샘플 XLSX를 평문으로 가져온다.
pub fn import_sample(conn: &mut Connection) {
    let plan = plan_import("sample.xlsx", parse_roster(&fixture()).unwrap()).unwrap();
    let bytes = std::fs::read(fixture()).unwrap();
    apply_import(conn, PLAIN, "sample.xlsx", &bytes, &plan).unwrap();
}

/// 샘플을 가져온 새 작업 파일(임시 폴더의 `t.mix`)
pub fn sample_db() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = crate::db::create_new(&dir.path().join("t.mix"), "t").unwrap();
    import_sample(&mut conn);
    (dir, conn)
}
