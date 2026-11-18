//! 프런트엔드에서 호출하는 Tauri 커맨드.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::{self, FILE_EXTENSION};
use crate::error::{AppError, AppResult};
use crate::roster::{self, GapDto, PdfApplyReport, PdfLink, PdfRowInput, StudentDto};
use crate::settings::{self, RecentFile};
use crate::xlsx_import::{self, ImportReport};

pub struct WorkFile {
    pub path: PathBuf,
    pub conn: Connection,
    pub read_only: bool,
}

#[derive(Default)]
pub struct AppState {
    pub file: Mutex<Option<WorkFile>>,
}

impl AppState {
    fn with_file<T>(&self, f: impl FnOnce(&mut WorkFile) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self
            .file
            .lock()
            .map_err(|_| AppError::Other("내부 잠금 오류".into()))?;
        let wf = guard.as_mut().ok_or(AppError::NoOpenFile)?;
        f(wf)
    }

    fn with_writable<T>(&self, f: impl FnOnce(&mut WorkFile) -> AppResult<T>) -> AppResult<T> {
        self.with_file(|wf| {
            if wf.read_only {
                return Err(AppError::ReadOnly);
            }
            f(wf)
        })
    }

    /// 열린 파일을 닫는다(열림 표시를 지움).
    pub fn close(&self) {
        if let Ok(mut guard) = self.file.lock()
            && let Some(wf) = guard.take()
            && !wf.read_only
        {
            let _ = wf.conn.execute(
                "UPDATE meta SET opened_by = NULL, opened_at = NULL WHERE id = 1",
                [],
            );
        }
    }
}

fn host_name() -> String {
    gethostname::gethostname().to_string_lossy().to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub read_only: bool,
    pub target_grade: Option<String>,
    pub class_count: Option<i64>,
    pub student_count: i64,
    pub xlsx_file_name: Option<String>,
    pub pdf_file_name: Option<String>,
    pub pdf_linked_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn workspace_info(wf: &WorkFile) -> AppResult<WorkspaceInfo> {
    let c = &wf.conn;
    let (title, target_grade, class_count, created_at, updated_at) = c.query_row(
        "SELECT title, target_grade, class_count, created_at, updated_at FROM meta WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let student_count = c.query_row("SELECT COUNT(*) FROM student", [], |r| r.get(0))?;
    let source = |kind: &str| -> AppResult<Option<String>> {
        let mut stmt = c.prepare(
            "SELECT file_name FROM source_file WHERE kind = ?1 ORDER BY id DESC LIMIT 1",
        )?;
        let mut rows = stmt.query(params![kind])?;
        Ok(match rows.next()? {
            Some(r) => Some(r.get(0)?),
            None => None,
        })
    };
    let pdf_linked_count = c.query_row(
        "SELECT COUNT(*) FROM student WHERE match_method IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    Ok(WorkspaceInfo {
        path: wf.path.to_string_lossy().to_string(),
        file_name: wf
            .path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        title,
        read_only: wf.read_only,
        target_grade,
        class_count,
        student_count,
        xlsx_file_name: source("xlsx")?,
        pdf_file_name: source("pdf")?,
        pdf_linked_count,
        created_at,
        updated_at,
    })
}

fn remember(app: &AppHandle, path: &Path) {
    let sp = settings::settings_path(app);
    let mut s = settings::load_from(&sp);
    settings::push_recent(&mut s, path);
    let _ = settings::save_to(&sp, &s);
}

fn with_extension(path: &str) -> PathBuf {
    let mut p = PathBuf::from(path);
    if p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case(FILE_EXTENSION))
        != Some(true)
    {
        let mut name = p.file_name().map(|s| s.to_os_string()).unwrap_or_default();
        name.push(format!(".{FILE_EXTENSION}"));
        p.set_file_name(name);
    }
    p
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub workspace: WorkspaceInfo,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn create_work_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<WorkspaceInfo> {
    let path = with_extension(&path);
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "반편성".into());
    state.close();
    let conn = db::create_new(&path, &title)?;
    conn.execute(
        "UPDATE meta SET opened_by = ?1, opened_at = ?2 WHERE id = 1",
        params![host_name(), db::now()],
    )?;
    let wf = WorkFile {
        path: path.clone(),
        conn,
        read_only: false,
    };
    let info = workspace_info(&wf)?;
    *state
        .file
        .lock()
        .map_err(|_| AppError::Other("내부 잠금 오류".into()))? = Some(wf);
    remember(&app, &path);
    Ok(info)
}

#[tauri::command]
pub async fn open_work_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<OpenResult> {
    let path = PathBuf::from(path);
    state.close();
    let (conn, outcome) = db::open_existing(&path)?;
    let mut warnings = Vec::new();
    if outcome.newer_version {
        warnings.push("더 새로운 버전의 ClassMix로 저장된 파일이라 읽기 전용으로 열었습니다. 앱을 업데이트해 주세요.".into());
    }
    if let Some(b) = &outcome.backup_path {
        warnings.push(format!(
            "이전 버전 파일을 새 형식으로 바꿨습니다. 원본 사본: {}",
            b.display()
        ));
    }
    if !outcome.read_only {
        let opened_by: Option<String> =
            conn.query_row("SELECT opened_by FROM meta WHERE id = 1", [], |r| r.get(0))?;
        let me = host_name();
        if let Some(other) = opened_by.filter(|h| *h != me) {
            warnings.push(format!(
                "이 파일이 다른 PC({other})에서 열려 있거나, 그 PC에서 제대로 닫히지 않았습니다. 두 곳에서 동시에 고치면 변경 내용이 섞일 수 있습니다."
            ));
        }
        conn.execute(
            "UPDATE meta SET opened_by = ?1, opened_at = ?2 WHERE id = 1",
            params![me, db::now()],
        )?;
    }
    let wf = WorkFile {
        path: path.clone(),
        conn,
        read_only: outcome.read_only,
    };
    let workspace = workspace_info(&wf)?;
    *state
        .file
        .lock()
        .map_err(|_| AppError::Other("내부 잠금 오류".into()))? = Some(wf);
    remember(&app, &path);
    Ok(OpenResult {
        workspace,
        warnings,
    })
}

#[tauri::command]
pub async fn close_work_file(state: State<'_, AppState>) -> AppResult<()> {
    state.close();
    Ok(())
}

#[tauri::command]
pub async fn get_workspace(state: State<'_, AppState>) -> AppResult<Option<WorkspaceInfo>> {
    let guard = state
        .file
        .lock()
        .map_err(|_| AppError::Other("내부 잠금 오류".into()))?;
    guard.as_ref().map(workspace_info).transpose()
}

/// 다른 이름으로 저장: 사본을 만들고 그 파일로 전환한다.
#[tauri::command]
pub async fn save_work_file_as(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<WorkspaceInfo> {
    let target = with_extension(&path);
    state.with_file(|wf| {
        if target == wf.path {
            return Err(AppError::InvalidInput(
                "지금 열려 있는 파일과 같은 경로입니다.".into(),
            ));
        }
        db::vacuum_into(&wf.conn, &target)
    })?;
    state.close();
    let (conn, outcome) = db::open_existing(&target)?;
    conn.execute(
        "UPDATE meta SET opened_by = ?1, opened_at = ?2, updated_at = ?2 WHERE id = 1",
        params![host_name(), db::now()],
    )?;
    let wf = WorkFile {
        path: target.clone(),
        conn,
        read_only: outcome.read_only,
    };
    let info = workspace_info(&wf)?;
    *state
        .file
        .lock()
        .map_err(|_| AppError::Other("내부 잠금 오류".into()))? = Some(wf);
    remember(&app, &target);
    Ok(info)
}

/// 사본 저장(백업): 지금 파일은 그대로 두고 사본만 만든다.
#[tauri::command]
pub async fn save_work_file_copy(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let target = with_extension(&path);
    state.with_file(|wf| {
        if target == wf.path {
            return Err(AppError::InvalidInput(
                "지금 열려 있는 파일과 같은 경로입니다.".into(),
            ));
        }
        db::vacuum_into(&wf.conn, &target)?;
        // 사본에는 열림 표시를 남기지 않는다.
        let copy = Connection::open(&target)?;
        copy.execute(
            "UPDATE meta SET opened_by = NULL, opened_at = NULL WHERE id = 1",
            [],
        )?;
        Ok(target.to_string_lossy().to_string())
    })
}

#[tauri::command]
pub async fn list_recent_files(app: AppHandle) -> AppResult<Vec<RecentFile>> {
    Ok(settings::recent_files(&settings::load_from(
        &settings::settings_path(&app),
    )))
}

#[tauri::command]
pub async fn remove_recent_file(app: AppHandle, path: String) -> AppResult<()> {
    let sp = settings::settings_path(&app);
    let mut s = settings::load_from(&sp);
    settings::remove_recent(&mut s, &path);
    settings::save_to(&sp, &s)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportXlsxResult {
    pub report: ImportReport,
    pub workspace: WorkspaceInfo,
}

#[tauri::command]
pub async fn import_xlsx(state: State<'_, AppState>, path: String) -> AppResult<ImportXlsxResult> {
    let src = PathBuf::from(&path);
    let file_name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let bytes = std::fs::read(&src)?;
    let plan = xlsx_import::plan_import(&file_name, xlsx_import::parse_roster(&src)?)?;
    state.with_writable(|wf| {
        xlsx_import::apply_import(&mut wf.conn, &file_name, &bytes, &plan)?;
        Ok(ImportXlsxResult {
            report: plan.report.clone(),
            workspace: workspace_info(wf)?,
        })
    })
}

#[tauri::command]
pub async fn list_students(state: State<'_, AppState>) -> AppResult<Vec<StudentDto>> {
    state.with_file(|wf| roster::list_students(&wf.conn))
}

#[tauri::command]
pub async fn list_gaps(state: State<'_, AppState>) -> AppResult<Vec<GapDto>> {
    state.with_file(|wf| roster::list_gaps(&wf.conn))
}

/// PDF 파일 내용을 그대로 돌려준다(프런트엔드에서 pdf.js로 파싱).
#[tauri::command]
pub async fn read_pdf_file(path: String) -> AppResult<tauri::ipc::Response> {
    let p = PathBuf::from(&path);
    if p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        != Some(true)
    {
        return Err(AppError::InvalidInput("PDF 파일이 아닙니다.".into()));
    }
    Ok(tauri::ipc::Response::new(std::fs::read(p)?))
}

#[tauri::command]
pub async fn apply_pdf_mapping(
    state: State<'_, AppState>,
    path: String,
    rows: Vec<PdfRowInput>,
    links: Vec<PdfLink>,
) -> AppResult<PdfApplyReport> {
    let src = PathBuf::from(&path);
    let file_name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let bytes = std::fs::read(&src)?;
    state.with_writable(|wf| roster::apply_pdf(&mut wf.conn, &file_name, &bytes, &rows, &links))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplePaths {
    pub xlsx: String,
    pub pdf: String,
}

/// 개발용: 디버그 빌드에서만 tests/fixtures 샘플 경로를 돌려준다(릴리스 빌드는 항상 None).
#[tauri::command]
pub async fn dev_sample_paths() -> AppResult<Option<SamplePaths>> {
    #[cfg(debug_assertions)]
    {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let (xlsx, pdf) = (dir.join("sample.xlsx"), dir.join("sample.pdf"));
        if xlsx.is_file() && pdf.is_file() {
            return Ok(Some(SamplePaths {
                xlsx: xlsx.to_string_lossy().to_string(),
                pdf: pdf.to_string_lossy().to_string(),
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_mix_extension() {
        assert_eq!(with_extension("/a/b"), PathBuf::from("/a/b.mix"));
        assert_eq!(with_extension("/a/b.MIX"), PathBuf::from("/a/b.MIX"));
        assert_eq!(
            with_extension("/a/2026 2학년.v1"),
            PathBuf::from("/a/2026 2학년.v1.mix")
        );
    }
}
