//! 반편성 변경(바꾸기·이동·번호·빈 번호·한글 발음)과 되돌리기/다시 실행.
//!
//! 새 상태 계산(재정렬, 번호 밀기 등)은 프런트엔드 순수 함수가 하고, 여기서는
//! 계산 결과를 "변경 묶음"(`ChangeSet`)으로 받아 한 트랜잭션에 적용하고 `change_log`에 남긴다.
//! 변경 묶음은 바꾸기 전·후 값을 모두 담고 있어, 되돌리기는 전·후를 뒤집어 적용하면 된다.
//! 적용 전에 "바꾸기 전" 값이 지금 DB와 같은지 확인해 어긋난 상태 위에 덮어쓰지 않는다.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::db::now;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seat {
    pub c: i64,
    pub n: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentMove {
    pub student_id: i64,
    pub from: Seat,
    pub to: Seat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GapRow {
    pub number: i64,
    pub anchor_key: String,
    pub planned_name: Option<String>,
    pub origin: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// 한 반의 빈 번호 전체(전·후). 빈 번호는 번호가 서로 얽혀 바뀌므로 반 단위로 통째로 바꾼다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassGaps {
    pub class: i64,
    pub before: Vec<GapRow>,
    pub after: Vec<GapRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumberingChange {
    pub class: i64,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingChange {
    pub student_id: i64,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    /// 'swap' | 'move' | 'renumber' | 'set_number' | 'gap_add' | 'gap_remove' | 'gap_edit' | 'set_reading' | 'reset'
    pub action: String,
    /// 이력에 보여 줄 설명. 예) "김나래 3반 → 5반"
    pub label: String,
    #[serde(default)]
    pub students: Vec<StudentMove>,
    #[serde(default)]
    pub gaps: Vec<ClassGaps>,
    #[serde(default)]
    pub numbering: Vec<NumberingChange>,
    #[serde(default)]
    pub readings: Vec<ReadingChange>,
}

const ACTIONS: &[&str] = &[
    "swap",
    "move",
    "renumber",
    "set_number",
    "gap_add",
    "gap_remove",
    "gap_edit",
    "set_reading",
    "reset",
];

impl ChangeSet {
    fn is_empty(&self) -> bool {
        self.students.iter().all(|m| m.from == m.to)
            && self.gaps.iter().all(|g| g.before == g.after)
            && self.numbering.iter().all(|n| n.from == n.to)
            && self.readings.iter().all(|r| r.from == r.to)
    }

    /// 전·후를 뒤집은 변경 묶음(되돌리기용)
    fn inverse(&self) -> ChangeSet {
        ChangeSet {
            action: self.action.clone(),
            label: self.label.clone(),
            students: self
                .students
                .iter()
                .map(|m| StudentMove {
                    student_id: m.student_id,
                    from: m.to,
                    to: m.from,
                })
                .collect(),
            gaps: self
                .gaps
                .iter()
                .map(|g| ClassGaps {
                    class: g.class,
                    before: g.after.clone(),
                    after: g.before.clone(),
                })
                .collect(),
            numbering: self
                .numbering
                .iter()
                .map(|n| NumberingChange {
                    class: n.class,
                    from: n.to.clone(),
                    to: n.from.clone(),
                })
                .collect(),
            readings: self
                .readings
                .iter()
                .map(|r| ReadingChange {
                    student_id: r.student_id,
                    from: r.to.clone(),
                    to: r.from.clone(),
                })
                .collect(),
        }
    }
}

fn stale() -> AppError {
    AppError::InvalidInput(
        "화면의 반편성 상태가 파일과 다릅니다. 화면을 새로 고친 뒤 다시 시도해 주세요.".into(),
    )
}

fn normalize_reading(s: &Option<String>) -> Option<String> {
    s.as_ref()
        .map(|v| v.chars().filter(|c| !c.is_whitespace()).collect::<String>())
        .filter(|v| !v.is_empty())
}

fn gap_sort_key(g: &GapRow) -> (i64, String, Option<String>, String) {
    (
        g.number,
        g.anchor_key.clone(),
        g.planned_name.clone(),
        g.origin.clone(),
    )
}

fn current_gaps(tx: &Transaction, class: i64) -> AppResult<Vec<GapRow>> {
    let mut stmt = tx.prepare(
        "SELECT number, anchor_key, planned_name, origin, created_at FROM number_gap WHERE class = ?1 ORDER BY number",
    )?;
    let rows = stmt
        .query_map(params![class], |r| {
            Ok(GapRow {
                number: r.get(0)?,
                anchor_key: r.get(1)?,
                planned_name: r.get(2)?,
                origin: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 변경 묶음을 트랜잭션 안에서 적용한다. "바꾸기 전" 값이 지금 상태와 다르면 오류.
fn apply_in_tx(tx: &Transaction, cs: &ChangeSet, class_count: i64) -> AppResult<()> {
    for m in &cs.students {
        let cur: Option<(i64, i64)> = tx
            .query_row(
                "SELECT cur_class, cur_number FROM student WHERE id = ?1",
                params![m.student_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((c, n)) = cur else {
            return Err(AppError::InvalidInput(format!(
                "학생을 찾을 수 없습니다: {}",
                m.student_id
            )));
        };
        if (c, n) != (m.from.c, m.from.n) {
            return Err(stale());
        }
        if m.to.c < 1 || m.to.c > class_count || m.to.n < 1 {
            return Err(AppError::InvalidInput(format!(
                "반·번호가 범위를 벗어났습니다: {}반 {}번",
                m.to.c, m.to.n
            )));
        }
        tx.execute(
            "UPDATE student SET cur_class = ?1, cur_number = ?2 WHERE id = ?3",
            params![m.to.c, m.to.n, m.student_id],
        )?;
    }

    for g in &cs.gaps {
        let mut now_rows: Vec<_> = current_gaps(tx, g.class)?
            .iter()
            .map(gap_sort_key)
            .collect();
        let mut before: Vec<_> = g.before.iter().map(gap_sort_key).collect();
        now_rows.sort();
        before.sort();
        if now_rows != before {
            return Err(stale());
        }
        tx.execute("DELETE FROM number_gap WHERE class = ?1", params![g.class])?;
        let ts = now();
        for row in &g.after {
            if !matches!(row.origin.as_str(), "manual" | "import") || row.number < 1 {
                return Err(AppError::InvalidInput(
                    "빈 번호 값이 잘못되었습니다.".into(),
                ));
            }
            tx.execute(
                "INSERT INTO number_gap (class, number, anchor_key, planned_name, origin, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    g.class,
                    row.number,
                    row.anchor_key,
                    row.planned_name,
                    row.origin,
                    row.created_at.clone().unwrap_or_else(|| ts.clone())
                ],
            )?;
        }
    }

    for nc in &cs.numbering {
        if !matches!(nc.to.as_str(), "original" | "sorted") {
            return Err(AppError::InvalidInput(
                "번호 상태 값이 잘못되었습니다.".into(),
            ));
        }
        let cur: Option<String> = tx
            .query_row(
                "SELECT numbering FROM class_state WHERE class = ?1",
                params![nc.class],
                |r| r.get(0),
            )
            .optional()?;
        if cur.as_deref().unwrap_or("original") != nc.from {
            return Err(stale());
        }
        tx.execute(
            "INSERT INTO class_state (class, numbering) VALUES (?1, ?2)
             ON CONFLICT(class) DO UPDATE SET numbering = excluded.numbering",
            params![nc.class, nc.to],
        )?;
    }

    for rc in &cs.readings {
        let cur: Option<Option<String>> = tx
            .query_row(
                "SELECT sort_name FROM student WHERE id = ?1",
                params![rc.student_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(cur) = cur else {
            return Err(AppError::InvalidInput(format!(
                "학생을 찾을 수 없습니다: {}",
                rc.student_id
            )));
        };
        if normalize_reading(&cur) != normalize_reading(&rc.from) {
            return Err(stale());
        }
        if let Some(v) = normalize_reading(&rc.to)
            && !v.chars().all(|c| ('가'..='힣').contains(&c))
        {
            return Err(AppError::InvalidInput(
                "한글 발음은 한글(완성형)만 입력할 수 있습니다.".into(),
            ));
        }
        tx.execute(
            "UPDATE student SET sort_name = ?1 WHERE id = ?2",
            params![normalize_reading(&rc.to), rc.student_id],
        )?;
    }

    // 결과 검사: 같은 반 번호 중복(학생·빈 번호 포함)
    let dup: Option<(i64, i64)> = tx
        .query_row(
            "SELECT c, n FROM (
               SELECT cur_class AS c, cur_number AS n FROM student
               UNION ALL SELECT class, number FROM number_gap
             ) GROUP BY c, n HAVING COUNT(*) > 1 LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((c, n)) = dup {
        return Err(AppError::InvalidInput(format!(
            "{c}반 {n}번이 겹칩니다. 변경을 적용하지 않았습니다."
        )));
    }
    tx.execute(
        "UPDATE meta SET updated_at = ?1 WHERE id = 1",
        params![now()],
    )?;
    Ok(())
}

fn class_count(conn: &Connection) -> AppResult<i64> {
    let n: Option<i64> = conn.query_row("SELECT class_count FROM meta WHERE id = 1", [], |r| {
        r.get(0)
    })?;
    n.ok_or_else(|| AppError::InvalidInput("XLSX를 먼저 가져와 주세요.".into()))
}

/// 새 변경을 적용하고 이력에 남긴다. 되돌린 뒤 남아 있던 "다시 실행" 기록은 지운다.
pub fn apply_change(conn: &mut Connection, cs: &ChangeSet) -> AppResult<()> {
    if !ACTIONS.contains(&cs.action.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "알 수 없는 변경: {}",
            cs.action
        )));
    }
    if cs.is_empty() {
        return Ok(());
    }
    let cc = class_count(conn)?;
    let tx = conn.transaction()?;
    apply_in_tx(&tx, cs, cc)?;
    tx.execute("DELETE FROM change_log WHERE undone = 1", [])?;
    let seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM change_log",
        [],
        |r| r.get(0),
    )?;
    let payload =
        serde_json::to_string(cs).map_err(|e| AppError::Other(format!("이력 저장 오류: {e}")))?;
    tx.execute(
        "INSERT INTO change_log (seq, action, payload, undone, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
        params![seq, cs.action, payload, now()],
    )?;
    tx.commit()?;
    Ok(())
}

fn load_payload(s: &str) -> AppResult<ChangeSet> {
    serde_json::from_str(s).map_err(|e| AppError::Other(format!("이력을 읽을 수 없습니다: {e}")))
}

/// 마지막 변경을 되돌린다. 되돌린 변경의 설명을 돌려준다(없으면 None).
pub fn undo(conn: &mut Connection) -> AppResult<Option<String>> {
    let cc = class_count(conn)?;
    let tx = conn.transaction()?;
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, payload FROM change_log WHERE undone = 0 ORDER BY seq DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((id, payload)) = row else {
        return Ok(None);
    };
    let cs = load_payload(&payload)?;
    apply_in_tx(&tx, &cs.inverse(), cc)?;
    tx.execute(
        "UPDATE change_log SET undone = 1 WHERE id = ?1",
        params![id],
    )?;
    tx.commit()?;
    Ok(Some(cs.label))
}

/// 되돌린 변경 중 가장 오래된 것을 다시 적용한다.
pub fn redo(conn: &mut Connection) -> AppResult<Option<String>> {
    let cc = class_count(conn)?;
    let tx = conn.transaction()?;
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT id, payload FROM change_log WHERE undone = 1 ORDER BY seq ASC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((id, payload)) = row else {
        return Ok(None);
    };
    let cs = load_payload(&payload)?;
    apply_in_tx(&tx, &cs, cc)?;
    tx.execute(
        "UPDATE change_log SET undone = 0 WHERE id = ?1",
        params![id],
    )?;
    tx.commit()?;
    Ok(Some(cs.label))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub seq: i64,
    pub action: String,
    pub label: String,
    /// 이 변경으로 반·번호가 바뀐 학생 id
    pub student_ids: Vec<i64>,
    pub undone: bool,
    pub created_at: String,
}

/// 변경 이력(최근 것 먼저). 되돌린 항목도 포함한다.
pub fn history(conn: &Connection, limit: i64) -> AppResult<Vec<HistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, seq, action, payload, undone, created_at FROM change_log ORDER BY seq DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, seq, action, payload, undone, created_at)| {
            let cs = load_payload(&payload)?;
            Ok(HistoryEntry {
                id,
                seq,
                action,
                label: cs.label,
                student_ids: cs
                    .students
                    .iter()
                    .filter(|m| m.from.c != m.to.c)
                    .map(|m| m.student_id)
                    .collect(),
                undone,
                created_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xlsx_import::{apply_import, parse_roster, plan_import};
    use std::path::Path;

    pub(crate) fn setup() -> (tempfile::TempDir, Connection) {
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

    fn seat(conn: &Connection, id: i64) -> (i64, i64) {
        conn.query_row(
            "SELECT cur_class, cur_number FROM student WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    fn mv(id: i64, from: (i64, i64), to: (i64, i64)) -> ChangeSet {
        ChangeSet {
            action: "move".into(),
            label: "이동".into(),
            students: vec![StudentMove {
                student_id: id,
                from: Seat {
                    c: from.0,
                    n: from.1,
                },
                to: Seat { c: to.0, n: to.1 },
            }],
            gaps: vec![],
            numbering: vec![NumberingChange {
                class: to.0,
                from: "original".into(),
                to: "sorted".into(),
            }],
            readings: vec![],
        }
    }

    #[test]
    fn apply_undo_redo_and_persist_history() {
        let (_d, mut conn) = setup();
        let from = seat(&conn, 1);
        let to = (if from.0 == 1 { 2 } else { 1 }, 99);
        apply_change(&mut conn, &mv(1, from, to)).unwrap();
        assert_eq!(seat(&conn, 1), to);
        // 같은 변경을 다시 보내면 상태가 어긋나 거절
        assert!(apply_change(&mut conn, &mv(1, from, to)).is_err());
        assert_eq!(undo(&mut conn).unwrap().as_deref(), Some("이동"));
        assert_eq!(seat(&conn, 1), from);
        let ns: String = conn
            .query_row(
                "SELECT numbering FROM class_state WHERE class = ?1",
                [to.0],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ns, "original");
        assert_eq!(undo(&mut conn).unwrap(), None);
        assert_eq!(redo(&mut conn).unwrap().as_deref(), Some("이동"));
        assert_eq!(seat(&conn, 1), to);
        assert_eq!(redo(&mut conn).unwrap(), None);
        let h = history(&conn, 10).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].student_ids, vec![1]);
        assert!(!h[0].undone);
    }

    #[test]
    fn rejects_duplicate_seat_and_leaves_state() {
        let (_d, mut conn) = setup();
        let a = seat(&conn, 1);
        let b = seat(&conn, 2);
        let mut cs = mv(1, a, b);
        cs.numbering.clear();
        let err = apply_change(&mut conn, &cs).unwrap_err();
        assert!(err.to_string().contains("겹칩니다"));
        assert_eq!(seat(&conn, 1), a);
        assert!(history(&conn, 10).unwrap().is_empty());
    }

    #[test]
    fn rejects_out_of_range_class() {
        let (_d, mut conn) = setup();
        let a = seat(&conn, 1);
        assert!(apply_change(&mut conn, &mv(1, a, (9, 1))).is_err());
    }

    #[test]
    fn gap_snapshot_must_match() {
        let (_d, mut conn) = setup();
        // 1반에는 가져온 결번 26번이 있다
        let before = vec![GapRow {
            number: 26,
            anchor_key: "x".into(),
            planned_name: None,
            origin: "import".into(),
            created_at: None,
        }];
        let cs = ChangeSet {
            action: "gap_remove".into(),
            label: "x".into(),
            students: vec![],
            gaps: vec![ClassGaps {
                class: 1,
                before,
                after: vec![],
            }],
            numbering: vec![],
            readings: vec![],
        };
        // 기준 키가 다르므로 어긋남
        assert!(apply_change(&mut conn, &cs).is_err());
    }

    #[test]
    fn new_change_clears_redo_and_validates_reading() {
        let (_d, mut conn) = setup();
        let r = |from: Option<&str>, to: Option<&str>| ChangeSet {
            action: "set_reading".into(),
            label: "발음".into(),
            students: vec![],
            gaps: vec![],
            numbering: vec![],
            readings: vec![ReadingChange {
                student_id: 1,
                from: from.map(Into::into),
                to: to.map(Into::into),
            }],
        };
        apply_change(&mut conn, &r(None, Some("가 나"))).unwrap();
        let v: Option<String> = conn
            .query_row("SELECT sort_name FROM student WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(v.as_deref(), Some("가나"));
        undo(&mut conn).unwrap();
        apply_change(&mut conn, &r(None, Some("다라"))).unwrap();
        assert_eq!(redo(&mut conn).unwrap(), None);
        assert!(apply_change(&mut conn, &r(Some("다라"), Some("ABC"))).is_err());
    }
}
