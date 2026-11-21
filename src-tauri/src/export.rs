//! 나이스 업로드용 XLSX 내보내기.
//!
//! 가져온 원본 XLSX(작업 파일 안 BLOB)를 템플릿으로 열어 `진급반코드`·`진급반번호` 셀 값만 바꾸고,
//! 행 순서·서식·학번 텍스트 형식·열 너비·시트 이름은 그대로 둔다.
//! 저장한 뒤 같은 파일을 다시 읽어 행 수·학번·반·번호가 맞는지 확인한다(왕복 검증).

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::Path;

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::crypto::Codec;
use crate::db::temp_path_for;
use crate::error::{AppError, AppResult};
use crate::xlsx_import::{header_columns, parse_roster};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub rows: usize,
    pub changed_students: usize,
}

struct Seat {
    row_index: u32,
    student_no: String,
    class: i64,
    number: i64,
    orig_class: i64,
    orig_number: i64,
}

fn load_seats(conn: &Connection, codec: Codec) -> AppResult<Vec<Seat>> {
    let mut stmt = conn.prepare(
        "SELECT row_index, student_no, cur_class, cur_number, orig_class, orig_number, id FROM student ORDER BY row_index",
    )?;
    let mut out = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        out.push(Seat {
            row_index: r.get(0)?,
            student_no: codec.get_text("student.student_no", r.get(6)?, r.get(1)?)?,
            class: r.get(2)?,
            number: r.get(3)?,
            orig_class: r.get(4)?,
            orig_number: r.get(5)?,
        });
    }
    Ok(out)
}

/// 내보내기를 막는 오류(번호 중복·범위 밖 반)를 확인한다.
fn check_blocking(conn: &Connection, seats: &[Seat]) -> AppResult<()> {
    let class_count: Option<i64> =
        conn.query_row("SELECT class_count FROM meta WHERE id = 1", [], |r| {
            r.get(0)
        })?;
    let class_count =
        class_count.ok_or_else(|| AppError::InvalidInput("XLSX를 먼저 가져와 주세요.".into()))?;
    if seats.is_empty() {
        return Err(AppError::InvalidInput("내보낼 학생이 없습니다.".into()));
    }
    let mut used: HashSet<(i64, i64)> = HashSet::new();
    for s in seats {
        if s.class < 1 || s.class > class_count {
            return Err(AppError::InvalidInput(format!(
                "학번 {}의 반({})이 1~{class_count}반 범위를 벗어났습니다.",
                s.student_no, s.class
            )));
        }
        if s.number < 1 {
            return Err(AppError::InvalidInput(format!(
                "학번 {}의 번호가 잘못되었습니다.",
                s.student_no
            )));
        }
        if !used.insert((s.class, s.number)) {
            return Err(AppError::InvalidInput(format!(
                "{}반 {}번이 두 명 이상입니다.",
                s.class, s.number
            )));
        }
    }
    let mut stmt = conn.prepare("SELECT class, number FROM number_gap")?;
    let gaps = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (c, n) in gaps {
        if used.contains(&(c, n)) {
            return Err(AppError::InvalidInput(format!(
                "{c}반 {n}번이 학생과 빈 번호에 함께 쓰였습니다."
            )));
        }
    }
    Ok(())
}

fn template(conn: &Connection, codec: Codec) -> AppResult<Vec<u8>> {
    let (id, raw): (i64, rusqlite::types::Value) = conn
        .query_row(
            "SELECT id, content FROM source_file WHERE kind = 'xlsx' ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AppError::InvalidInput("작업 파일에 원본 XLSX가 없습니다.".into()))?;
    codec.get_blob("source_file.content", id, raw)
}

pub fn export_xlsx(conn: &Connection, codec: Codec, path: &Path) -> AppResult<ExportReport> {
    let seats = load_seats(conn, codec)?;
    check_blocking(conn, &seats)?;
    let bytes = template(conn, codec)?;

    let mut book = umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(bytes), true)
        .map_err(|e| AppError::Xlsx(e.to_string()))?;
    let sheet = book
        .sheet_mut(0)
        .map_err(|e| AppError::Xlsx(e.to_string()))?;
    let cols = header_columns(sheet)?;
    let (col_no, col_class, col_number) = (cols["학번"], cols["진급반코드"], cols["진급반번호"]);
    let (_, max_row) = sheet.highest_column_and_row();

    // 1) 학생 행에 값 쓰기(학번이 원본 행과 같은지 확인)
    let by_row: HashMap<u32, &Seat> = seats.iter().map(|s| (s.row_index, s)).collect();
    for s in &seats {
        let no = sheet.value((col_no, s.row_index)).trim().to_string();
        if no != s.student_no {
            return Err(AppError::Other(format!(
                "원본 XLSX {}행의 학번({no})이 작업 파일({})과 다릅니다.",
                s.row_index, s.student_no
            )));
        }
        sheet
            .cell_mut((col_class, s.row_index))
            .set_value_number(s.class as f64);
        sheet
            .cell_mut((col_number, s.row_index))
            .set_value_number(s.number as f64);
    }

    // 2) 가져올 때 모든 행을 학생으로 저장했으므로, 학생과 이어지지 않은 행이 있으면 원본과 작업 파일이 어긋난 것이다.
    let stray: Vec<u32> = (2..=max_row)
        .filter(|row| !by_row.contains_key(row))
        .filter(|row| {
            cols.values()
                .any(|col| !sheet.value((*col, *row)).trim().is_empty())
        })
        .collect();
    if !stray.is_empty() {
        return Err(AppError::Other(format!(
            "원본 XLSX의 {}행이 작업 파일의 학생과 이어지지 않습니다.",
            stray
                .iter()
                .take(5)
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }

    // 3) 임시 파일에 쓴 뒤 바꿔치기(쓰다가 실패해도 기존 파일이 깨지지 않게)
    let tmp = temp_path_for(path);
    umya_spreadsheet::writer::xlsx::write(&book, &tmp).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::Xlsx(format!("저장하지 못했습니다: {e}"))
    })?;

    // 4) 왕복 검증
    let verify = || -> AppResult<()> {
        let rows = parse_roster(&tmp)?;
        if rows.len() != seats.len() {
            return Err(AppError::Other(format!(
                "왕복 검증 실패: 행 수가 다릅니다(파일 {} / 학생 {}).",
                rows.len(),
                seats.len()
            )));
        }
        let expected: HashMap<&str, (i64, i64)> = seats
            .iter()
            .map(|s| (s.student_no.as_str(), (s.class, s.number)))
            .collect();
        for r in &rows {
            match expected.get(r.student_no.as_str()) {
                Some(&(c, n)) if r.next_class == Some(c) && r.next_number == Some(n) => {}
                Some(_) => {
                    return Err(AppError::Other(format!(
                        "왕복 검증 실패: 학번 {}의 반·번호가 다르게 저장되었습니다.",
                        r.student_no
                    )));
                }
                None => {
                    return Err(AppError::Other(format!(
                        "왕복 검증 실패: 작업 파일에 없는 학번 {}이 있습니다.",
                        r.student_no
                    )));
                }
            }
        }
        Ok(())
    };
    if let Err(e) = verify() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;

    conn.execute(
        "UPDATE meta SET updated_at = ?1 WHERE id = 1",
        params![crate::db::now()],
    )
    .ok();

    Ok(ExportReport {
        path: path.to_string_lossy().to_string(),
        rows: seats.len(),
        changed_students: seats
            .iter()
            .filter(|s| (s.class, s.number) != (s.orig_class, s.orig_number))
            .count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes::{self, ChangeSet, NumberingChange, Seat as S, StudentMove};
    use crate::crypto::PLAIN;
    use crate::xlsx_import::{apply_import, plan_import};

    fn fixture() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sample.xlsx")
    }

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::create_new(&dir.path().join("t.mix"), "t").unwrap();
        let plan = plan_import("sample.xlsx", parse_roster(&fixture()).unwrap()).unwrap();
        apply_import(
            &mut conn,
            PLAIN,
            "sample.xlsx",
            &std::fs::read(fixture()).unwrap(),
            &plan,
        )
        .unwrap();
        (dir, conn)
    }

    #[test]
    fn unchanged_export_matches_original() {
        let (dir, conn) = setup();
        let out = dir.path().join("한글 폴더/업로드.xlsx");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        let rep = export_xlsx(&conn, PLAIN, &out).unwrap();
        assert_eq!((rep.rows, rep.changed_students), (240, 0));
        assert!(!temp_path_for(&out).exists());

        let orig: Vec<_> = parse_roster(&fixture())
            .unwrap()
            .into_iter()
            .filter(|r| r.prev_grade == "1학년")
            .collect();
        let got = parse_roster(&out).unwrap();
        assert_eq!(got.len(), orig.len());
        for (a, b) in orig.iter().zip(&got) {
            assert_eq!(
                (
                    &a.student_no,
                    &a.name,
                    &a.prev_course,
                    &a.prev_grade,
                    a.prev_class,
                    a.prev_number,
                    &a.next_course,
                    &a.next_grade,
                    a.next_class,
                    a.next_number
                ),
                (
                    &b.student_no,
                    &b.name,
                    &b.prev_course,
                    &b.prev_grade,
                    b.prev_class,
                    b.prev_number,
                    &b.next_course,
                    &b.next_grade,
                    b.next_class,
                    b.next_number
                )
            );
        }

        // 양식 보존: 시트 이름, 학번 텍스트 형식, 열 너비
        let src = umya_spreadsheet::reader::xlsx::read(fixture()).unwrap();
        let dst = umya_spreadsheet::reader::xlsx::read(&out).unwrap();
        let (s0, d0) = (src.sheet(0).unwrap(), dst.sheet(0).unwrap());
        assert_eq!(s0.name(), d0.name());
        let fmt = |ws: &umya_spreadsheet::Worksheet| {
            ws.cell((1, 2)).and_then(|c| {
                c.style()
                    .number_format()
                    .map(|f| f.format_code().to_string())
            })
        };
        assert_eq!(fmt(s0), fmt(d0));
        assert_eq!(fmt(d0).as_deref(), Some("@"));
        for col in ["A", "B", "I", "J"] {
            assert_eq!(
                s0.column_dimension(col).map(|c| c.width()),
                d0.column_dimension(col).map(|c| c.width())
            );
        }
    }

    #[test]
    fn exports_changed_seats_as_numbers() {
        let (dir, mut conn) = setup();
        let (id, c, n, no): (i64, i64, i64, String) = conn
            .query_row(
                "SELECT id, cur_class, cur_number, student_no FROM student WHERE cur_class = 1 ORDER BY cur_number DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        let cs = ChangeSet {
            action: "move".into(),
            label: "x".into(),
            students: vec![StudentMove {
                student_id: id,
                from: S { c, n },
                to: S { c: 2, n: 50 },
            }],
            gaps: vec![],
            numbering: vec![NumberingChange {
                class: 2,
                from: "original".into(),
                to: "sorted".into(),
            }],
            readings: vec![],
        };
        changes::apply_change(&mut conn, PLAIN, &cs).unwrap();
        let out = dir.path().join("o.xlsx");
        let rep = export_xlsx(&conn, PLAIN, &out).unwrap();
        assert_eq!(rep.changed_students, 1);
        let row = parse_roster(&out)
            .unwrap()
            .into_iter()
            .find(|r| r.student_no == no)
            .unwrap();
        assert_eq!((row.next_class, row.next_number), (Some(2), Some(50)));
        // 숫자형으로 저장(문자열 '02' 아님)
        let book = umya_spreadsheet::reader::xlsx::read(&out).unwrap();
        let ws = book.sheet(0).unwrap();
        let cols = header_columns(ws).unwrap();
        let r = (2..=ws.highest_column_and_row().1)
            .find(|r| ws.value((cols["학번"], *r)).trim() == no)
            .unwrap();
        let cell = ws.cell((cols["진급반코드"], r)).unwrap();
        assert_eq!(cell.data_type(), "n");
    }

    /// 원본 XLSX에 학생과 이어지지 않는 행이 있으면(작업 파일이 어긋남) 지우지 않고 멈춘다.
    #[test]
    fn refuses_rows_without_student() {
        let (dir, conn) = setup();
        conn.execute("DELETE FROM student WHERE row_index = 3", [])
            .unwrap();
        let out = dir.path().join("o.xlsx");
        let err = export_xlsx(&conn, PLAIN, &out).unwrap_err();
        assert!(
            err.to_string()
                .contains("3행이 작업 파일의 학생과 이어지지 않습니다")
        );
        assert!(!out.exists());
    }

    #[test]
    fn blocks_duplicate_seats() {
        let (dir, conn) = setup();
        conn.execute(
            "UPDATE student SET cur_class = 1, cur_number = 1 WHERE id IN (1, 2)",
            [],
        )
        .unwrap();
        let err = export_xlsx(&conn, PLAIN, &dir.path().join("x.xlsx")).unwrap_err();
        assert!(err.to_string().contains("두 명 이상"));
        assert!(!dir.path().join("x.xlsx").exists());
    }
}
