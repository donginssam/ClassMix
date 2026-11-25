//! 반편성 보드에 필요한 조회와, 되돌리기 대상이 아닌 편집(메모·분리 규칙·쌍둥이 후보 넘기기).

use std::collections::{BTreeMap, HashSet};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::changes::{self, HistoryCache, HistoryEntry};
use crate::crypto::Codec;
use crate::db::{next_id, now};
use crate::error::{AppError, AppResult};
use crate::roster::{self, GapDto, StudentDto};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassStateDto {
    pub class: i64,
    pub numbering: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMember {
    pub student_id: i64,
    /// 'member' | 'leader'(1:N형의 A)
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDto {
    pub id: i64,
    pub kind: String,
    pub origin: String,
    pub enabled: bool,
    pub reason: Option<String>,
    pub created_at: String,
    pub members: Vec<RuleMember>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardData {
    pub students: Vec<StudentDto>,
    pub gaps: Vec<GapDto>,
    pub class_states: Vec<ClassStateDto>,
    pub rules: Vec<RuleDto>,
    /// "쌍둥이 아님"으로 넘긴 쌍 [a, b] (a < b)
    pub dismissed_twins: Vec<[i64; 2]>,
    pub history: Option<Vec<HistoryEntry>>,
    pub can_undo: bool,
    pub can_redo: bool,
}

pub fn list_class_states(conn: &Connection) -> AppResult<Vec<ClassStateDto>> {
    let mut stmt = conn.prepare("SELECT class, numbering FROM class_state ORDER BY class")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ClassStateDto {
                class: r.get(0)?,
                numbering: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_rules(conn: &Connection, codec: Codec) -> AppResult<Vec<RuleDto>> {
    let mut members: BTreeMap<i64, Vec<RuleMember>> = BTreeMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT rule_id, student_id, role FROM separation_member ORDER BY rule_id, role DESC, student_id")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                RuleMember {
                    student_id: r.get(1)?,
                    role: r.get(2)?,
                },
            ))
        })?;
        for row in rows {
            let (rule_id, m) = row?;
            members.entry(rule_id).or_default().push(m);
        }
    }
    let mut stmt = conn.prepare(
        "SELECT id, kind, origin, enabled, reason, created_at FROM separation_rule ORDER BY id",
    )?;
    let mut rows = Vec::new();
    let mut q = stmt.query([])?;
    while let Some(r) = q.next()? {
        let id: i64 = r.get(0)?;
        rows.push(RuleDto {
            id,
            kind: r.get(1)?,
            origin: r.get(2)?,
            enabled: r.get(3)?,
            reason: codec.get_opt_text("separation_rule.reason", id, r.get(4)?)?,
            created_at: r.get(5)?,
            members: Vec::new(),
        });
    }
    Ok(rows
        .into_iter()
        .map(|mut r| {
            r.members = members.remove(&r.id).unwrap_or_default();
            r
        })
        .collect())
}

fn dismissed_twins(conn: &Connection) -> AppResult<Vec<[i64; 2]>> {
    let mut stmt = conn.prepare(
        "SELECT student_a, student_b FROM twin_candidate_dismissed ORDER BY student_a, student_b",
    )?;
    let rows = stmt
        .query_map([], |r| Ok([r.get(0)?, r.get(1)?]))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 캐시 없이 보드 데이터를 읽는다(테스트용).
#[cfg(test)]
pub fn board_data(conn: &Connection, codec: Codec) -> AppResult<BoardData> {
    board_data_cached(conn, codec, Some(&mut HistoryCache::default()))
}

/// 보드를 읽는다. 이력이 필요한 경우에만 열린 파일의 요약 캐시를 넘긴다.
pub fn board_data_cached(
    conn: &Connection,
    codec: Codec,
    history_cache: Option<&mut HistoryCache>,
) -> AppResult<BoardData> {
    let history = history_cache
        .map(|cache| changes::history_cached(conn, codec, 300, cache))
        .transpose()?;
    let can_undo = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM change_log WHERE undone = 0)",
        [],
        |r| r.get(0),
    )?;
    let can_redo = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM change_log WHERE undone = 1)",
        [],
        |r| r.get(0),
    )?;
    Ok(BoardData {
        students: roster::list_students(conn, codec)?,
        gaps: roster::list_gaps(conn, codec)?,
        class_states: list_class_states(conn)?,
        rules: list_rules(conn, codec)?,
        dismissed_twins: dismissed_twins(conn)?,
        history,
        can_undo,
        can_redo,
    })
}

pub fn set_memo(
    conn: &Connection,
    codec: Codec,
    student_id: i64,
    memo: Option<String>,
) -> AppResult<()> {
    let memo = memo.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    // 바꾸기와 수정 시각을 한 트랜잭션으로(둘 중 하나만 남지 않게)
    let tx = conn.unchecked_transaction()?;
    let n = tx.execute(
        "UPDATE student SET memo = ?1 WHERE id = ?2",
        params![
            codec.opt_text("student.memo", student_id, memo.as_deref())?,
            student_id
        ],
    )?;
    if n != 1 {
        return Err(AppError::InvalidInput("학생을 찾을 수 없습니다.".into()));
    }
    tx.execute(
        "UPDATE meta SET updated_at = ?1 WHERE id = 1",
        params![now()],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRule {
    pub kind: String,
    pub reason: Option<String>,
    pub members: Vec<RuleMember>,
}

fn validate_members(kind: &str, members: &[RuleMember]) -> AppResult<()> {
    let mut seen = HashSet::new();
    for m in members {
        if !seen.insert(m.student_id) {
            return Err(AppError::InvalidInput(
                "같은 학생이 두 번 들어 있습니다.".into(),
            ));
        }
        if !matches!(m.role.as_str(), "member" | "leader") {
            return Err(AppError::InvalidInput(format!(
                "알 수 없는 역할: {}",
                m.role
            )));
        }
    }
    let leaders = members.iter().filter(|m| m.role == "leader").count();
    match kind {
        "one_to_many" => {
            if leaders != 1 || members.len() < 2 {
                return Err(AppError::InvalidInput(
                    "1:N형은 기준 학생 1명과 다른 학생 1명 이상이 필요합니다.".into(),
                ));
            }
        }
        "group" | "twin" | "same_name" => {
            if leaders != 0 || members.len() < 2 {
                return Err(AppError::InvalidInput(
                    "학생을 2명 이상 골라 주세요.".into(),
                ));
            }
        }
        _ => {
            return Err(AppError::InvalidInput(format!(
                "알 수 없는 규칙 종류: {kind}"
            )));
        }
    }
    Ok(())
}

/// 교사가 직접 만드는 분리 규칙(그룹형·1:N형·쌍둥이)
pub fn create_rule(conn: &mut Connection, codec: Codec, rule: &NewRule) -> AppResult<i64> {
    if rule.kind == "same_name" {
        return Err(AppError::InvalidInput(
            "동명이인 규칙은 XLSX를 가져올 때 자동으로 만들어집니다.".into(),
        ));
    }
    validate_members(&rule.kind, &rule.members)?;
    let reason = rule
        .reason
        .as_ref()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty());
    let ts = now();
    let tx = conn.transaction()?;
    let id = next_id(&tx, "separation_rule")?;
    tx.execute(
        "INSERT INTO separation_rule (id, kind, origin, enabled, reason, created_at) VALUES (?1, ?2, 'manual', 1, ?3, ?4)",
        params![
            id,
            rule.kind,
            codec.opt_text("separation_rule.reason", id, reason.as_deref())?,
            ts
        ],
    )?;
    for m in &rule.members {
        tx.execute(
            "INSERT INTO separation_member (rule_id, student_id, role) VALUES (?1, ?2, ?3)",
            params![id, m.student_id, m.role],
        )?;
    }
    tx.execute("UPDATE meta SET updated_at = ?1 WHERE id = 1", params![ts])?;
    tx.commit()?;
    Ok(id)
}

pub fn update_rule(
    conn: &Connection,
    codec: Codec,
    id: i64,
    enabled: bool,
    reason: Option<String>,
) -> AppResult<()> {
    let reason = reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty());
    let tx = conn.unchecked_transaction()?;
    let n = tx.execute(
        "UPDATE separation_rule SET enabled = ?1, reason = ?2 WHERE id = ?3",
        params![
            enabled,
            codec.opt_text("separation_rule.reason", id, reason.as_deref())?,
            id
        ],
    )?;
    if n != 1 {
        return Err(AppError::InvalidInput("규칙을 찾을 수 없습니다.".into()));
    }
    tx.execute(
        "UPDATE meta SET updated_at = ?1 WHERE id = 1",
        params![now()],
    )?;
    tx.commit()?;
    Ok(())
}

/// 직접 만든 규칙만 지울 수 있다. 자동 규칙(동명이인)은 끄기만 한다.
pub fn delete_rule(conn: &Connection, id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let n = tx.execute(
        "DELETE FROM separation_rule WHERE id = ?1 AND kind != 'same_name'",
        params![id],
    )?;
    if n != 1 {
        return Err(AppError::InvalidInput(
            "지울 수 없는 규칙입니다. 동명이인 규칙은 끄기만 할 수 있습니다.".into(),
        ));
    }
    tx.execute(
        "UPDATE meta SET updated_at = ?1 WHERE id = 1",
        params![now()],
    )?;
    tx.commit()?;
    Ok(())
}

/// 쌍둥이 후보 검토 결과를 한 번에 반영한다: 등록할 묶음은 쌍둥이 규칙으로, 아닌 묶음은 모든 쌍을 "아님"으로.
pub fn resolve_twin_candidates(
    conn: &mut Connection,
    codec: Codec,
    register: &[Vec<i64>],
    dismiss: &[Vec<i64>],
) -> AppResult<()> {
    let ts = now();
    let tx = conn.transaction()?;
    for group in register {
        let members: Vec<RuleMember> = group
            .iter()
            .map(|id| RuleMember {
                student_id: *id,
                role: "member".into(),
            })
            .collect();
        validate_members("twin", &members)?;
        let id = next_id(&tx, "separation_rule")?;
        tx.execute(
            "INSERT INTO separation_rule (id, kind, origin, enabled, reason, created_at) VALUES (?1, 'twin', 'auto', 1, ?2, ?3)",
            params![id, codec.text("separation_rule.reason", id, "쌍둥이")?, ts],
        )?;
        for m in &members {
            tx.execute(
                "INSERT INTO separation_member (rule_id, student_id, role) VALUES (?1, ?2, 'member')",
                params![id, m.student_id],
            )?;
        }
    }
    for group in dismiss {
        for (i, a) in group.iter().enumerate() {
            for b in &group[i + 1..] {
                let (x, y) = if a < b { (a, b) } else { (b, a) };
                if x == y {
                    continue;
                }
                tx.execute(
                    "INSERT OR IGNORE INTO twin_candidate_dismissed (student_a, student_b) VALUES (?1, ?2)",
                    params![x, y],
                )?;
            }
        }
    }
    tx.execute("UPDATE meta SET updated_at = ?1 WHERE id = 1", params![ts])?;
    tx.commit()?;
    Ok(())
}
