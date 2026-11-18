//! 나이스 진급반편성 XLSX 가져오기.
//!
//! 1. `parse_roster`: 첫 시트를 헤더 이름으로 읽어 행 목록을 만든다(순수 함수).
//! 2. `plan_import`: 전입·전출 행을 건너뛰고 검증해 저장할 학생·경고를 정한다(순수 함수).
//! 3. `apply_import`: 한 트랜잭션으로 DB에 저장한다(원본 BLOB, 학생, 반 상태, 가져온 결번, 동명이인 규칙).

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use rusqlite::{Connection, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::now;
use crate::error::{AppError, AppResult};
use crate::names::{collapse_spaces, same_name_key};

pub const HEADERS: [&str; 10] = [
    "학번",
    "성명",
    "이전주야과정구분",
    "이전학년",
    "이전반",
    "이전번호",
    "진급주야과정구분",
    "진급학년",
    "진급반코드",
    "진급반번호",
];

#[derive(Debug, Clone)]
pub struct RosterRow {
    /// 엑셀 행 번호(1부터, 헤더가 1행)
    pub row_index: u32,
    pub student_no: String,
    pub name: String,
    pub prev_course: String,
    pub prev_grade: String,
    pub prev_class: Option<i64>,
    pub prev_number: Option<i64>,
    pub next_course: String,
    pub next_grade: String,
    pub next_class: Option<i64>,
    pub next_number: Option<i64>,
    /// 숫자로 해석할 수 없었던 칸(열 이름)
    pub bad_numbers: Vec<&'static str>,
}

fn parse_int(raw: &str) -> Result<Option<i64>, ()> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if let Ok(v) = s.parse::<i64>() {
        return Ok(Some(v));
    }
    match s.parse::<f64>() {
        Ok(f) if f.fract() == 0.0 && f.abs() < 1e12 => Ok(Some(f as i64)),
        _ => Err(()),
    }
}

/// 첫 시트를 읽어 행 목록으로 바꾼다. 필수 헤더가 없으면 오류.
pub fn parse_roster(path: &Path) -> AppResult<Vec<RosterRow>> {
    let book =
        umya_spreadsheet::reader::xlsx::read(path).map_err(|e| AppError::Xlsx(e.to_string()))?;
    let sheet = book.sheet(0).map_err(|e| AppError::Xlsx(e.to_string()))?;
    let (max_col, max_row) = sheet.highest_column_and_row();

    let mut col_of: HashMap<&'static str, u32> = HashMap::new();
    for col in 1..=max_col {
        let header: String = sheet
            .value((col, 1))
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if let Some(h) = HEADERS.iter().find(|h| **h == header) {
            col_of.entry(h).or_insert(col);
        }
    }
    let missing: Vec<&str> = HEADERS
        .iter()
        .copied()
        .filter(|h| !col_of.contains_key(h))
        .collect();
    if !missing.is_empty() {
        return Err(AppError::InvalidXlsx(format!(
            "나이스 진급반편성 양식이 아닙니다. 1행에 다음 열이 없습니다: {}",
            missing.join(", ")
        )));
    }

    let text = |h: &str, row: u32| -> String { sheet.value((col_of[h], row)).trim().to_string() };
    let mut rows = Vec::new();
    for row in 2..=max_row {
        let values: Vec<String> = HEADERS.iter().map(|h| text(h, row)).collect();
        if values.iter().all(|v| v.is_empty()) {
            continue;
        }
        let mut bad = Vec::new();
        let mut int = |h: &'static str| -> Option<i64> {
            match parse_int(&text(h, row)) {
                Ok(v) => v,
                Err(()) => {
                    bad.push(h);
                    None
                }
            }
        };
        let prev_class = int("이전반");
        let prev_number = int("이전번호");
        let next_class = int("진급반코드");
        let next_number = int("진급반번호");
        rows.push(RosterRow {
            row_index: row,
            student_no: text("학번", row),
            // 성명은 원문 그대로 보관(앞뒤 공백 포함). 비교에는 name_norm을 쓴다.
            name: sheet.value((col_of["성명"], row)),
            prev_course: text("이전주야과정구분", row),
            prev_grade: text("이전학년", row),
            prev_class,
            prev_number,
            next_course: text("진급주야과정구분", row),
            next_grade: text("진급학년", row),
            next_class,
            next_number,
            bad_numbers: bad,
        });
    }
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRow {
    pub row: u32,
    pub student_no: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassSummary {
    pub class: i64,
    pub count: usize,
    /// 가져온 나이스 번호의 결번(마지막 번호 이전)
    pub gaps: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub file_name: String,
    pub total_rows: usize,
    pub imported: usize,
    pub skipped: Vec<SkippedRow>,
    pub warnings: Vec<String>,
    pub target_grade: String,
    pub class_count: i64,
    pub classes: Vec<ClassSummary>,
    /// 자동으로 분리 규칙을 만든 동명이인 그룹(성명 목록)
    pub same_name_groups: Vec<Vec<String>>,
    /// 성명에 로마자가 있는 학생 수(한글 발음 입력 대상, M6)
    pub roman_name_count: usize,
}

#[derive(Debug)]
pub struct ImportPlan {
    pub students: Vec<RosterRow>,
    pub report: ImportReport,
}

fn is_transfer(grade: &str) -> Option<&'static str> {
    match grade {
        "전입" => Some("전입"),
        "전출" => Some("전출"),
        _ => None,
    }
}

fn list_rows(rows: &[&RosterRow]) -> String {
    let shown: Vec<String> = rows
        .iter()
        .take(5)
        .map(|r| format!("{}행({})", r.row_index, collapse_spaces(&r.name)))
        .collect();
    let more = if rows.len() > 5 {
        format!(" 외 {}건", rows.len() - 5)
    } else {
        String::new()
    };
    format!("{}{}", shown.join(", "), more)
}

/// 행 목록을 검증해 저장할 학생과 보고서를 만든다.
pub fn plan_import(file_name: &str, rows: Vec<RosterRow>) -> AppResult<ImportPlan> {
    let total_rows = rows.len();
    let mut skipped = Vec::new();
    let mut students = Vec::new();
    for r in rows {
        if let Some(kind) = is_transfer(&r.prev_grade) {
            skipped.push(SkippedRow {
                row: r.row_index,
                student_no: r.student_no.clone(),
                name: collapse_spaces(&r.name),
                reason: format!("{kind} 학생(진급 반편성 대상 아님)"),
            });
            continue;
        }
        if r.prev_class.is_none() || r.prev_number.is_none() {
            skipped.push(SkippedRow {
                row: r.row_index,
                student_no: r.student_no.clone(),
                name: collapse_spaces(&r.name),
                reason: "이전반·이전번호가 비어 있음".into(),
            });
            continue;
        }
        students.push(r);
    }

    if students.is_empty() {
        return Err(AppError::InvalidXlsx("가져올 학생이 없습니다.".into()));
    }

    // 오류: 숫자 칸 형식
    let bad: Vec<&RosterRow> = students
        .iter()
        .filter(|r| !r.bad_numbers.is_empty())
        .collect();
    if !bad.is_empty() {
        return Err(AppError::InvalidXlsx(format!(
            "반·번호 칸에 숫자가 아닌 값이 있습니다: {}",
            list_rows(&bad)
        )));
    }
    // 오류: 학번·성명 누락
    let no_id: Vec<&RosterRow> = students
        .iter()
        .filter(|r| r.student_no.is_empty() || r.name.trim().is_empty())
        .collect();
    if !no_id.is_empty() {
        return Err(AppError::InvalidXlsx(format!(
            "학번 또는 성명이 비어 있습니다: {}",
            list_rows(&no_id)
        )));
    }
    // 오류: 학번 중복
    let mut by_no: HashMap<&str, Vec<&RosterRow>> = HashMap::new();
    for r in &students {
        by_no.entry(r.student_no.as_str()).or_default().push(r);
    }
    let dup_no: Vec<&RosterRow> = by_no
        .values()
        .filter(|v| v.len() > 1)
        .flatten()
        .copied()
        .collect();
    if !dup_no.is_empty() {
        return Err(AppError::InvalidXlsx(format!(
            "학번이 중복됩니다: {}",
            list_rows(&dup_no)
        )));
    }
    // 오류: 진급반 미편성 (나이스 기본 편성 전 파일)
    let unassigned: Vec<&RosterRow> = students
        .iter()
        .filter(|r| !matches!((r.next_class, r.next_number), (Some(c), Some(n)) if c > 0 && n > 0))
        .collect();
    if !unassigned.is_empty() {
        return Err(AppError::InvalidXlsx(format!(
            "진급반코드·진급반번호가 비어 있는 학생이 있습니다. 나이스에서 기본 편성을 마친 뒤 내려받은 파일인지 확인해 주세요. ({})",
            list_rows(&unassigned)
        )));
    }
    // 오류: 같은 반 번호 중복
    let mut by_seat: BTreeMap<(i64, i64), Vec<&RosterRow>> = BTreeMap::new();
    for r in &students {
        by_seat
            .entry((r.next_class.unwrap(), r.next_number.unwrap()))
            .or_default()
            .push(r);
    }
    let dup_seat: Vec<&RosterRow> = by_seat
        .values()
        .filter(|v| v.len() > 1)
        .flatten()
        .copied()
        .collect();
    if !dup_seat.is_empty() {
        return Err(AppError::InvalidXlsx(format!(
            "같은 반에 같은 진급반번호가 있습니다: {}",
            list_rows(&dup_seat)
        )));
    }

    // 경고
    let mut warnings = Vec::new();
    let mut by_prev: BTreeMap<(i64, i64), Vec<&RosterRow>> = BTreeMap::new();
    for r in &students {
        by_prev
            .entry((r.prev_class.unwrap(), r.prev_number.unwrap()))
            .or_default()
            .push(r);
    }
    for ((c, n), v) in &by_prev {
        if v.len() > 1 {
            let names: Vec<String> = v.iter().map(|r| collapse_spaces(&r.name)).collect();
            warnings.push(format!(
                "이전 {c}반 {n}번이 {}명입니다({}). PDF 매핑은 진급반·번호와 성명으로 하므로 영향이 없습니다.",
                v.len(),
                names.join(", ")
            ));
        }
    }
    let mut grade_count: BTreeMap<&str, usize> = BTreeMap::new();
    for r in &students {
        *grade_count.entry(r.next_grade.as_str()).or_default() += 1;
    }
    let target_grade = grade_count
        .iter()
        .max_by_key(|(_, n)| **n)
        .map(|(g, _)| g.to_string())
        .unwrap_or_default();
    if grade_count.len() > 1 {
        warnings.push(format!(
            "진급학년 값이 여러 가지입니다: {}",
            grade_count.keys().copied().collect::<Vec<_>>().join(", ")
        ));
    }

    // 반별 요약과 결번
    let class_count = students
        .iter()
        .filter_map(|r| r.next_class)
        .max()
        .unwrap_or(0);
    let mut classes = Vec::new();
    for class in 1..=class_count {
        let mut nums: Vec<i64> = students
            .iter()
            .filter(|r| r.next_class == Some(class))
            .filter_map(|r| r.next_number)
            .collect();
        nums.sort_unstable();
        let last = nums.last().copied().unwrap_or(0);
        let gaps: Vec<i64> = (1..last)
            .filter(|n| nums.binary_search(n).is_err())
            .collect();
        if nums.is_empty() {
            warnings.push(format!("{class}반에 학생이 없습니다."));
        }
        classes.push(ClassSummary {
            class,
            count: nums.len(),
            gaps,
        });
    }

    // 동명이인
    let mut by_name: BTreeMap<String, Vec<&RosterRow>> = BTreeMap::new();
    for r in &students {
        by_name.entry(same_name_key(&r.name)).or_default().push(r);
    }
    let same_name_groups: Vec<Vec<String>> = by_name
        .values()
        .filter(|v| v.len() > 1)
        .map(|v| v.iter().map(|r| collapse_spaces(&r.name)).collect())
        .collect();

    let roman_name_count = students
        .iter()
        .filter(|r| r.name.chars().any(|c| c.is_ascii_alphabetic()))
        .count();

    let report = ImportReport {
        file_name: file_name.to_string(),
        total_rows,
        imported: students.len(),
        skipped,
        warnings,
        target_grade,
        class_count,
        classes,
        same_name_groups,
        roman_name_count,
    };
    Ok(ImportPlan { students, report })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// DB에 저장한다. 이미 학생이 있는 파일이면 거절한다(다시 가져오려면 새 작업 파일을 만든다).
pub fn apply_import(
    conn: &mut Connection,
    file_name: &str,
    bytes: &[u8],
    plan: &ImportPlan,
) -> AppResult<()> {
    let existing: i64 = conn.query_row("SELECT COUNT(*) FROM student", [], |r| r.get(0))?;
    if existing > 0 {
        return Err(AppError::InvalidInput(
            "이미 XLSX를 가져온 작업 파일입니다. 다른 XLSX로 작업하려면 새 반편성 파일을 만들어 주세요.".into(),
        ));
    }
    let ts = now();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO source_file (kind, file_name, sha256, content, imported_at) VALUES ('xlsx', ?1, ?2, ?3, ?4)",
        params![file_name, sha256_hex(bytes), bytes, ts],
    )?;

    let mut ids: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "INSERT INTO student (row_index, student_no, name, name_norm, prev_course, prev_grade, prev_class, prev_number,
                                  next_course, next_grade, orig_class, orig_number, cur_class, cur_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?11, ?12)",
        )?;
        for r in &plan.students {
            stmt.execute(params![
                r.row_index,
                r.student_no,
                r.name,
                collapse_spaces(&r.name),
                r.prev_course,
                r.prev_grade,
                r.prev_class,
                r.prev_number,
                r.next_course,
                r.next_grade,
                r.next_class,
                r.next_number,
            ])?;
            ids.insert(r.student_no.clone(), tx.last_insert_rowid());
        }
    }

    for c in &plan.report.classes {
        tx.execute(
            "INSERT INTO class_state (class, numbering) VALUES (?1, 'original')",
            params![c.class],
        )?;
        // 가져온 결번은 빈 번호로 보관해 나중에 재정렬해도 사라지지 않게 한다.
        for gap in &c.gaps {
            let anchor: String = plan
                .students
                .iter()
                .filter(|r| r.next_class == Some(c.class) && r.next_number.unwrap_or(0) < *gap)
                .max_by_key(|r| r.next_number)
                .map(|r| collapse_spaces(&r.name))
                .unwrap_or_default();
            tx.execute(
                "INSERT INTO number_gap (class, number, anchor_key, origin, created_at) VALUES (?1, ?2, ?3, 'import', ?4)",
                params![c.class, gap, anchor, ts],
            )?;
        }
    }

    // 동명이인 분리 규칙 자동 생성
    let mut by_name: BTreeMap<String, Vec<&RosterRow>> = BTreeMap::new();
    for r in &plan.students {
        by_name.entry(same_name_key(&r.name)).or_default().push(r);
    }
    for group in by_name.values().filter(|v| v.len() > 1) {
        tx.execute(
            "INSERT INTO separation_rule (kind, origin, enabled, reason, created_at) VALUES ('same_name', 'auto', 1, '동명이인', ?1)",
            params![ts],
        )?;
        let rule_id = tx.last_insert_rowid();
        for r in group {
            tx.execute(
                "INSERT INTO separation_member (rule_id, student_id, role) VALUES (?1, ?2, 'member')",
                params![rule_id, ids[&r.student_no]],
            )?;
        }
    }

    tx.execute(
        "UPDATE meta SET target_grade = ?1, class_count = ?2, updated_at = ?3 WHERE id = 1",
        params![plan.report.target_grade, plan.report.class_count, ts],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sample.xlsx")
    }

    #[test]
    fn parses_sample() {
        let rows = parse_roster(&fixture()).unwrap();
        assert_eq!(rows.len(), 235);
        let first = &rows[0];
        assert_eq!(first.student_no, "2025000114");
        assert_eq!(first.name, "갑돌이");
        assert_eq!((first.prev_class, first.prev_number), (Some(1), Some(1)));
        assert_eq!((first.next_class, first.next_number), (Some(5), Some(1)));
    }

    #[test]
    fn plans_sample_import() {
        let plan = plan_import("sample.xlsx", parse_roster(&fixture()).unwrap()).unwrap();
        let r = &plan.report;
        assert_eq!(r.imported, 231);
        assert_eq!(r.skipped.len(), 4);
        assert_eq!(r.class_count, 8);
        assert_eq!(r.target_grade, "2학년");
        // 이전학적 중복 경고 2건(4-6, 6-28)
        assert_eq!(
            r.warnings.iter().filter(|w| w.starts_with("이전 ")).count(),
            2
        );
        // 동명이인 3그룹(바쿠, 오로라, 토순이)
        assert_eq!(r.same_name_groups.len(), 3);
        // 전입·전출 행을 빼서 생긴 결번
        let gaps: Vec<(i64, Vec<i64>)> = r
            .classes
            .iter()
            .filter(|c| !c.gaps.is_empty())
            .map(|c| (c.class, c.gaps.clone()))
            .collect();
        assert_eq!(gaps, vec![(1, vec![26]), (3, vec![10]), (6, vec![19])]);
        assert_eq!(r.roman_name_count, 3);
    }

    #[test]
    fn rejects_unassigned_file() {
        let mut rows = parse_roster(&fixture()).unwrap();
        rows[0].next_class = None;
        let err = plan_import("x.xlsx", rows).unwrap_err();
        assert!(err.to_string().contains("기본 편성"));
    }

    #[test]
    fn applies_to_new_work_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::create_new(&dir.path().join("t.mix"), "t").unwrap();
        let bytes = std::fs::read(fixture()).unwrap();
        let plan = plan_import("sample.xlsx", parse_roster(&fixture()).unwrap()).unwrap();
        apply_import(&mut conn, "sample.xlsx", &bytes, &plan).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM student", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 231);
        let rules: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM separation_rule WHERE kind='same_name'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rules, 3);
        let gaps: i64 = conn
            .query_row("SELECT COUNT(*) FROM number_gap", [], |r| r.get(0))
            .unwrap();
        assert_eq!(gaps, 3);
        let (no, name, norm): (String, String, String) = conn
            .query_row(
                "SELECT student_no, name, name_norm FROM student WHERE student_no='2025000083'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (no.as_str(), name.as_str(), norm.as_str()),
            ("2025000083", "앙꼬 ", "앙꼬")
        );
        // 두 번 가져오기 거절
        assert!(apply_import(&mut conn, "sample.xlsx", &bytes, &plan).is_err());
    }
}
