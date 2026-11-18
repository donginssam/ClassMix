//! 학생 목록 조회와 PDF(기준성적) 반영.

use std::collections::HashSet;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::now;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentDto {
    pub id: i64,
    pub student_no: String,
    pub name: String,
    pub name_norm: String,
    pub prev_grade: String,
    pub prev_class: i64,
    pub prev_number: i64,
    pub orig_class: i64,
    pub orig_number: i64,
    pub cur_class: i64,
    pub cur_number: i64,
    pub gender: Option<String>,
    pub birth_date: Option<String>,
    pub base_score: Option<f64>,
    pub match_method: Option<String>,
    pub memo: Option<String>,
    pub sort_name: Option<String>,
    /// 켜져 있는 동명이인 분리 규칙에 속하는지
    pub same_name: bool,
}

pub fn list_students(conn: &Connection) -> AppResult<Vec<StudentDto>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.student_no, s.name, s.name_norm, s.prev_grade, s.prev_class, s.prev_number,
                s.orig_class, s.orig_number, s.cur_class, s.cur_number, s.gender, s.birth_date, s.base_score,
                s.match_method, s.memo, s.sort_name,
                EXISTS (SELECT 1 FROM separation_member m JOIN separation_rule r ON r.id = m.rule_id
                        WHERE m.student_id = s.id AND r.kind = 'same_name' AND r.enabled = 1)
         FROM student s ORDER BY s.cur_class, s.cur_number",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(StudentDto {
                id: r.get(0)?,
                student_no: r.get(1)?,
                name: r.get(2)?,
                name_norm: r.get(3)?,
                prev_grade: r.get(4)?,
                prev_class: r.get(5)?,
                prev_number: r.get(6)?,
                orig_class: r.get(7)?,
                orig_number: r.get(8)?,
                cur_class: r.get(9)?,
                cur_number: r.get(10)?,
                gender: r.get(11)?,
                birth_date: r.get(12)?,
                base_score: r.get(13)?,
                match_method: r.get(14)?,
                memo: r.get(15)?,
                sort_name: r.get(16)?,
                same_name: r.get(17)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapDto {
    pub id: i64,
    pub class: i64,
    pub number: i64,
    pub planned_name: Option<String>,
    pub origin: String,
}

pub fn list_gaps(conn: &Connection) -> AppResult<Vec<GapDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, class, number, planned_name, origin FROM number_gap ORDER BY class, number",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(GapDto {
                id: r.get(0)?,
                class: r.get(1)?,
                number: r.get(2)?,
                planned_name: r.get(3)?,
                origin: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 프런트엔드에서 파싱한 PDF 행
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRowInput {
    pub page: i64,
    pub grade: String,
    pub class: i64,
    pub number: i64,
    pub name: String,
    pub birth_date: Option<String>,
    pub gender: Option<String>,
    pub base_score: Option<f64>,
    pub prev_grade: Option<String>,
    pub prev_class: Option<i64>,
    pub prev_number: Option<i64>,
    pub note: Option<String>,
}

/// PDF 행 ↔ 학생 연결
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfLink {
    pub row_index: usize,
    pub student_id: i64,
    pub method: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfApplyReport {
    pub linked: usize,
    pub unlinked_rows: usize,
}

/// PDF 원본과 매핑 결과를 저장한다. 기존 PDF 반영 내용은 모두 교체한다.
pub fn apply_pdf(
    conn: &mut Connection,
    file_name: &str,
    bytes: &[u8],
    rows: &[PdfRowInput],
    links: &[PdfLink],
) -> AppResult<PdfApplyReport> {
    let mut seen_rows = HashSet::new();
    let mut seen_students = HashSet::new();
    for l in links {
        if l.row_index >= rows.len() {
            return Err(AppError::InvalidInput(format!(
                "PDF 행 번호가 잘못되었습니다: {}",
                l.row_index
            )));
        }
        if !seen_rows.insert(l.row_index) || !seen_students.insert(l.student_id) {
            return Err(AppError::InvalidInput(
                "한 학생 또는 PDF 행이 두 번 연결되었습니다.".into(),
            ));
        }
        if !matches!(
            l.method.as_str(),
            "next_seat+name" | "prev_seat+name" | "name" | "manual"
        ) {
            return Err(AppError::InvalidInput(format!(
                "알 수 없는 매핑 방식: {}",
                l.method
            )));
        }
    }
    for r in rows {
        if let Some(g) = &r.gender
            && g != "남"
            && g != "여"
        {
            return Err(AppError::InvalidInput(format!(
                "성별 값이 잘못되었습니다: {g}"
            )));
        }
    }

    let ts = now();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM pdf_row", [])?;
    tx.execute("DELETE FROM source_file WHERE kind = 'pdf'", [])?;
    tx.execute("UPDATE student SET gender = NULL, birth_date = NULL, base_score = NULL, match_method = NULL", [])?;
    let sha: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    tx.execute(
        "INSERT INTO source_file (kind, file_name, sha256, content, imported_at) VALUES ('pdf', ?1, ?2, ?3, ?4)",
        params![file_name, sha, bytes, ts],
    )?;

    let link_of = |i: usize| links.iter().find(|l| l.row_index == i);
    for (i, r) in rows.iter().enumerate() {
        let link = link_of(i);
        tx.execute(
            "INSERT INTO pdf_row (page, grade, class, number, name, birth_date, gender, base_score, prev_grade, prev_class, prev_number, note, student_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                r.page, r.grade, r.class, r.number, r.name, r.birth_date, r.gender, r.base_score,
                r.prev_grade, r.prev_class, r.prev_number, r.note, link.map(|l| l.student_id)
            ],
        )?;
        if let Some(l) = link {
            let n = tx.execute(
                "UPDATE student SET gender = ?1, birth_date = ?2, base_score = ?3, match_method = ?4 WHERE id = ?5",
                params![r.gender, r.birth_date, r.base_score, l.method, l.student_id],
            )?;
            if n != 1 {
                return Err(AppError::InvalidInput(format!(
                    "학생을 찾을 수 없습니다: {}",
                    l.student_id
                )));
            }
        }
    }
    tx.execute("UPDATE meta SET updated_at = ?1 WHERE id = 1", params![ts])?;
    tx.commit()?;
    Ok(PdfApplyReport {
        linked: links.len(),
        unlinked_rows: rows.len() - links.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xlsx_import::{apply_import, parse_roster, plan_import};
    use std::path::Path;

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::create_new(&dir.path().join("t.mix"), "t").unwrap();
        let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sample.xlsx");
        let plan = plan_import("sample.xlsx", parse_roster(&fx).unwrap()).unwrap();
        apply_import(
            &mut conn,
            "sample.xlsx",
            &std::fs::read(&fx).unwrap(),
            &plan,
        )
        .unwrap();
        (dir, conn)
    }

    fn row(name: &str) -> PdfRowInput {
        PdfRowInput {
            page: 1,
            grade: "2학년".into(),
            class: 5,
            number: 1,
            name: name.into(),
            birth_date: Some("2010-01-01".into()),
            gender: Some("남".into()),
            base_score: Some(900.5),
            prev_grade: Some("1학년".into()),
            prev_class: Some(1),
            prev_number: Some(1),
            note: None,
        }
    }

    #[test]
    fn lists_students_with_same_name_flag() {
        let (_d, conn) = setup();
        let s = list_students(&conn).unwrap();
        assert_eq!(s.len(), 231);
        assert_eq!(s.iter().filter(|x| x.same_name).count(), 6);
        assert_eq!(list_gaps(&conn).unwrap().len(), 3);
    }

    #[test]
    fn applies_and_replaces_pdf_mapping() {
        let (_d, mut conn) = setup();
        let id: i64 = conn
            .query_row(
                "SELECT id FROM student WHERE student_no='2025000114'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let rows = vec![row("갑돌이"), row("없는학생")];
        let links = vec![PdfLink {
            row_index: 0,
            student_id: id,
            method: "next_seat+name".into(),
        }];
        let rep = apply_pdf(&mut conn, "sample.pdf", b"%PDF-", &rows, &links).unwrap();
        assert_eq!((rep.linked, rep.unlinked_rows), (1, 1));
        let score: Option<f64> = conn
            .query_row("SELECT base_score FROM student WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(score, Some(900.5));

        // 다시 반영하면 이전 값은 지워진다
        apply_pdf(&mut conn, "sample.pdf", b"%PDF-", &rows, &[]).unwrap();
        let score: Option<f64> = conn
            .query_row("SELECT base_score FROM student WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(score, None);
        let pdfs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM source_file WHERE kind='pdf'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pdfs, 1);
    }

    #[test]
    fn rejects_double_links() {
        let (_d, mut conn) = setup();
        let rows = vec![row("a"), row("b")];
        let links = vec![
            PdfLink {
                row_index: 0,
                student_id: 1,
                method: "manual".into(),
            },
            PdfLink {
                row_index: 1,
                student_id: 1,
                method: "manual".into(),
            },
        ];
        assert!(apply_pdf(&mut conn, "x.pdf", b"", &rows, &links).is_err());
    }
}
