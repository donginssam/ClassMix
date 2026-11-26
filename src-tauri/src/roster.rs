//! 학생 목록 조회와 PDF(기준성적) 반영.

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::crypto::Codec;
use crate::db::{insert_source_file, next_id, now, touch};
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
    /// 기준성적 ×100 정수(0.01점 단위)
    pub base_score: Option<i64>,
    pub match_method: Option<String>,
    pub memo: Option<String>,
    pub sort_name: Option<String>,
    /// 동명이인 분리 규칙에 속하는지(규칙을 꺼도 구분 꼬리표는 항상 붙인다)
    pub same_name: bool,
}

pub fn list_students(conn: &Connection, codec: Codec) -> AppResult<Vec<StudentDto>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.student_no, s.name, s.name_norm, s.prev_grade, s.prev_class, s.prev_number,
                s.orig_class, s.orig_number, s.cur_class, s.cur_number, s.gender, s.birth_date, s.base_score,
                s.match_method, s.memo, s.sort_name,
                EXISTS (SELECT 1 FROM separation_member m JOIN separation_rule r ON r.id = m.rule_id
                        WHERE m.student_id = s.id AND r.kind = 'same_name')
         FROM student s ORDER BY s.cur_class, s.cur_number, s.id",
    )?;
    let mut out = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let v = |i: usize| r.get::<_, Value>(i);
        let id: i64 = r.get(0)?;
        out.push(StudentDto {
            id,
            student_no: codec.get_text("student.student_no", id, v(1)?)?,
            name: codec.get_text("student.name", id, v(2)?)?,
            name_norm: codec.get_text("student.name_norm", id, v(3)?)?,
            prev_grade: codec.get_text("student.prev_grade", id, v(4)?)?,
            prev_class: codec.get_int("student.prev_class", id, v(5)?)?,
            prev_number: codec.get_int("student.prev_number", id, v(6)?)?,
            orig_class: r.get(7)?,
            orig_number: r.get(8)?,
            cur_class: r.get(9)?,
            cur_number: r.get(10)?,
            gender: r.get(11)?,
            birth_date: codec.get_opt_text("student.birth_date", id, v(12)?)?,
            base_score: codec.get_opt_int("student.base_score", id, v(13)?)?,
            match_method: r.get(14)?,
            memo: codec.get_opt_text("student.memo", id, v(15)?)?,
            sort_name: codec.get_opt_text("student.sort_name", id, v(16)?)?,
            same_name: r.get(17)?,
        });
    }
    Ok(out)
}

/// 배치 변경이 건드릴 수 있는 학생 값: 현재 반·번호와 한글 표기.
pub type StudentPlacement = (i64, i64, i64, Option<String>);

pub fn list_student_placements(
    conn: &Connection,
    codec: Codec,
) -> AppResult<Vec<StudentPlacement>> {
    let mut stmt = conn.prepare(
        "SELECT id, cur_class, cur_number, sort_name FROM student ORDER BY cur_class, cur_number, id",
    )?;
    let mut rows = stmt.query([])?;
    let mut placements = Vec::new();
    while let Some(row) = rows.next()? {
        let id = row.get(0)?;
        placements.push((
            id,
            row.get(1)?,
            row.get(2)?,
            codec.get_opt_text("student.sort_name", id, row.get(3)?)?,
        ));
    }
    Ok(placements)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapDto {
    pub id: i64,
    pub class: i64,
    pub number: i64,
    pub anchor_key: String,
    pub planned_name: Option<String>,
    pub origin: String,
    pub created_at: String,
}

pub fn list_gaps(conn: &Connection, codec: Codec) -> AppResult<Vec<GapDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, class, number, anchor_key, planned_name, origin, created_at FROM number_gap ORDER BY class, number",
    )?;
    let mut out = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let id: i64 = r.get(0)?;
        out.push(GapDto {
            id,
            class: r.get(1)?,
            number: r.get(2)?,
            anchor_key: codec.get_text("number_gap.anchor_key", id, r.get(3)?)?,
            planned_name: codec.get_opt_text("number_gap.planned_name", id, r.get(4)?)?,
            origin: r.get(5)?,
            created_at: r.get(6)?,
        });
    }
    Ok(out)
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
    /// 기준성적 ×100 정수(0.01점 단위)
    pub base_score: Option<i64>,
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
    codec: Codec,
    file_name: &str,
    bytes: &[u8],
    rows: &[PdfRowInput],
    links: &[PdfLink],
) -> AppResult<PdfApplyReport> {
    let mut links_by_row = HashMap::with_capacity(links.len());
    let mut seen_students = HashSet::new();
    for l in links {
        if l.row_index >= rows.len() {
            return Err(AppError::InvalidInput(format!(
                "PDF 행 번호가 잘못되었습니다: {}",
                l.row_index
            )));
        }
        if links_by_row.insert(l.row_index, l).is_some() || !seen_students.insert(l.student_id) {
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
    insert_source_file(&tx, codec, "pdf", file_name, bytes, &ts)?;

    for (i, r) in rows.iter().enumerate() {
        let link = links_by_row.get(&i).copied();
        let pid = next_id(&tx, "pdf_row")?;
        tx.execute(
            "INSERT INTO pdf_row (id, page, grade, class, number, name, birth_date, gender, base_score, prev_grade, prev_class, prev_number, note, student_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                pid,
                r.page,
                codec.text("pdf_row.grade", pid, &r.grade)?,
                codec.int("pdf_row.class", pid, r.class)?,
                codec.int("pdf_row.number", pid, r.number)?,
                codec.text("pdf_row.name", pid, &r.name)?,
                codec.opt_text("pdf_row.birth_date", pid, r.birth_date.as_deref())?,
                r.gender,
                codec.opt_int("pdf_row.base_score", pid, r.base_score)?,
                codec.opt_text("pdf_row.prev_grade", pid, r.prev_grade.as_deref())?,
                codec.opt_int("pdf_row.prev_class", pid, r.prev_class)?,
                codec.opt_int("pdf_row.prev_number", pid, r.prev_number)?,
                codec.opt_text("pdf_row.note", pid, r.note.as_deref())?,
                link.map(|l| l.student_id)
            ],
        )?;
        if let Some(l) = link {
            let n = tx.execute(
                "UPDATE student SET gender = ?1, birth_date = ?2, base_score = ?3, match_method = ?4 WHERE id = ?5",
                params![
                    r.gender,
                    codec.opt_text("student.birth_date", l.student_id, r.birth_date.as_deref())?,
                    codec.opt_int("student.base_score", l.student_id, r.base_score)?,
                    l.method,
                    l.student_id
                ],
            )?;
            if n != 1 {
                return Err(AppError::InvalidInput(format!(
                    "학생을 찾을 수 없습니다: {}",
                    l.student_id
                )));
            }
        }
    }
    touch(&tx, &ts)?;
    tx.commit()?;
    Ok(PdfApplyReport {
        linked: links.len(),
        unlinked_rows: rows.len() - links.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::PLAIN;
    use crate::test_support::sample_db;

    fn row(name: &str) -> PdfRowInput {
        PdfRowInput {
            page: 1,
            grade: "2학년".into(),
            class: 5,
            number: 1,
            name: name.into(),
            birth_date: Some("2010-01-01".into()),
            gender: Some("남".into()),
            base_score: Some(90050),
            prev_grade: Some("1학년".into()),
            prev_class: Some(1),
            prev_number: Some(1),
            note: None,
        }
    }

    #[test]
    fn lists_students_with_same_name_flag() {
        let (_d, conn) = sample_db();
        let s = list_students(&conn, PLAIN).unwrap();
        assert_eq!(s.len(), 240);
        assert_eq!(s.iter().filter(|x| x.same_name).count(), 24);
        assert!(list_gaps(&conn, PLAIN).unwrap().is_empty());
    }

    #[test]
    fn applies_and_replaces_pdf_mapping() {
        let (_d, mut conn) = sample_db();
        let id: i64 = conn
            .query_row(
                "SELECT id FROM student WHERE student_no='2026510398'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let rows = vec![row("갈매기"), row("없는학생")];
        let links = vec![PdfLink {
            row_index: 0,
            student_id: id,
            method: "next_seat+name".into(),
        }];
        let rep = apply_pdf(&mut conn, PLAIN, "sample.pdf", b"%PDF-", &rows, &links).unwrap();
        assert_eq!((rep.linked, rep.unlinked_rows), (1, 1));
        let score: Option<i64> = conn
            .query_row("SELECT base_score FROM student WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(score, Some(90050));

        // 다시 반영하면 이전 값은 지워진다
        apply_pdf(&mut conn, PLAIN, "sample.pdf", b"%PDF-", &rows, &[]).unwrap();
        let score: Option<i64> = conn
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
        let (_d, mut conn) = sample_db();
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
        assert!(apply_pdf(&mut conn, PLAIN, "x.pdf", b"", &rows, &links).is_err());
    }
}
