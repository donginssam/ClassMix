//! 프런트엔드에서 호출하는 Tauri 커맨드.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::board::{self, BoardData, NewRule};
use crate::changes::{self, ChangeSet};
use crate::crypto::{self, Cipher, Codec};
use crate::db::{self, FILE_EXTENSION};
use crate::error::{AppError, AppResult};
use crate::export::{self, ExportReport};
use crate::os_integration::{self, AssociationStatus};
use crate::roster::{self, GapDto, PdfApplyReport, PdfLink, PdfRowInput, StudentDto};
use crate::settings::{self, RecentFile};
use crate::xlsx_import::{self, ImportReport};

pub struct WorkFile {
    pub path: PathBuf,
    pub conn: Connection,
    pub read_only: bool,
    /// 암호가 걸린 파일인지(meta에 salt가 있음)
    pub encrypted: bool,
    /// 비밀번호로 만든 키. 파일을 연 동안만 메모리에 두고, 닫으면 버린다(키 내용은 지워짐).
    pub cipher: Option<Cipher>,
}

impl WorkFile {
    fn new(path: PathBuf, conn: Connection, read_only: bool) -> AppResult<Self> {
        let encrypted = crypto::header(&conn)?.is_some();
        Ok(Self {
            path,
            conn,
            read_only,
            encrypted,
            cipher: None,
        })
    }

    fn locked(&self) -> bool {
        self.encrypted && self.cipher.is_none()
    }
}

/// 열린 파일의 부호기. `wf.conn`을 따로 빌릴 수 있도록 필드만 빌린다.
macro_rules! codec {
    ($wf:expr) => {
        Codec($wf.cipher.as_ref())
    };
}

#[derive(Default)]
pub struct AppState {
    pub file: Mutex<Option<WorkFile>>,
    /// 실행 인자·더블클릭·두 번째 실행으로 받은, 화면이 아직 열지 않은 `.mix` 경로
    pub pending_open: Mutex<Option<PathBuf>>,
}

impl AppState {
    /// 열 파일을 맡겨 둔다(화면이 `take_launch_file`로 가져감).
    pub fn request_open(&self, path: PathBuf) {
        if let Ok(mut p) = self.pending_open.lock() {
            *p = Some(path);
        }
    }

    fn with_file<T>(&self, f: impl FnOnce(&mut WorkFile) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self
            .file
            .lock()
            .map_err(|_| AppError::Other("내부 잠금 오류".into()))?;
        let wf = guard.as_mut().ok_or(AppError::NoOpenFile)?;
        if wf.locked() {
            return Err(AppError::Locked);
        }
        f(wf)
    }

    /// 잠긴 파일이어도 부르는 동작(비밀번호 입력 등)
    fn with_file_even_locked<T>(
        &self,
        f: impl FnOnce(&mut WorkFile) -> AppResult<T>,
    ) -> AppResult<T> {
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
    /// 암호가 걸린 파일인지
    pub encrypted: bool,
    /// 암호가 걸려 있고 아직 비밀번호를 넣지 않았는지(이때는 학생 자료를 읽을 수 없음)
    pub locked: bool,
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
        encrypted: wf.encrypted,
        locked: wf.locked(),
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
    let wf = WorkFile::new(path.clone(), conn, false)?;
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
    // 새 파일을 먼저 열어 본 뒤에 지금 파일을 닫는다(ClassMix 파일이 아니거나 못 열면 지금 파일을 그대로 둔다).
    let (conn, outcome) = db::open_existing(&path)?;
    state.close();
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
    let wf = WorkFile::new(path.clone(), conn, outcome.read_only)?;
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
    // 사본은 같은 키로 암호화되어 있으므로, 지금 파일의 키를 넘겨받아 다시 묻지 않는다.
    let cipher = state.with_file(|wf| {
        if target == wf.path {
            return Err(AppError::InvalidInput(
                "지금 열려 있는 파일과 같은 경로입니다.".into(),
            ));
        }
        db::vacuum_into(&wf.conn, &target)?;
        Ok(wf.cipher.take())
    })?;
    state.close();
    let (conn, outcome) = db::open_existing(&target)?;
    conn.execute(
        "UPDATE meta SET opened_by = ?1, opened_at = ?2, updated_at = ?2 WHERE id = 1",
        params![host_name(), db::now()],
    )?;
    let mut wf = WorkFile::new(target.clone(), conn, outcome.read_only)?;
    wf.cipher = cipher;
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
        // 사본의 열림 표시 지우기까지 임시 파일에서 마친 뒤 바꿔 넣는다(db::vacuum_into).
        db::vacuum_into(&wf.conn, &target)?;
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
        xlsx_import::apply_import(&mut wf.conn, codec!(wf), &file_name, &bytes, &plan)?;
        Ok(ImportXlsxResult {
            report: plan.report.clone(),
            workspace: workspace_info(wf)?,
        })
    })
}

#[tauri::command]
pub async fn list_students(state: State<'_, AppState>) -> AppResult<Vec<StudentDto>> {
    state.with_file(|wf| roster::list_students(&wf.conn, codec!(wf)))
}

#[tauri::command]
pub async fn list_gaps(state: State<'_, AppState>) -> AppResult<Vec<GapDto>> {
    state.with_file(|wf| roster::list_gaps(&wf.conn, codec!(wf)))
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
    state.with_writable(|wf| {
        roster::apply_pdf(&mut wf.conn, codec!(wf), &file_name, &bytes, &rows, &links)
    })
}

// ───────────── 반편성 보드(M4~M7) ─────────────

#[tauri::command]
pub async fn get_board(state: State<'_, AppState>) -> AppResult<BoardData> {
    state.with_file(|wf| board::board_data(&wf.conn, codec!(wf)))
}

#[tauri::command]
pub async fn apply_change(state: State<'_, AppState>, change: ChangeSet) -> AppResult<()> {
    state.with_writable(|wf| changes::apply_change(&mut wf.conn, codec!(wf), &change))
}

#[tauri::command]
pub async fn undo_change(state: State<'_, AppState>) -> AppResult<Option<String>> {
    state.with_writable(|wf| changes::undo(&mut wf.conn, codec!(wf)))
}

#[tauri::command]
pub async fn redo_change(state: State<'_, AppState>) -> AppResult<Option<String>> {
    state.with_writable(|wf| changes::redo(&mut wf.conn, codec!(wf)))
}

#[tauri::command]
pub async fn set_memo(
    state: State<'_, AppState>,
    student_id: i64,
    memo: Option<String>,
) -> AppResult<()> {
    state.with_writable(|wf| board::set_memo(&wf.conn, codec!(wf), student_id, memo))
}

#[tauri::command]
pub async fn create_rule(state: State<'_, AppState>, rule: NewRule) -> AppResult<i64> {
    state.with_writable(|wf| board::create_rule(&mut wf.conn, codec!(wf), &rule))
}

#[tauri::command]
pub async fn update_rule(
    state: State<'_, AppState>,
    id: i64,
    enabled: bool,
    reason: Option<String>,
) -> AppResult<()> {
    state.with_writable(|wf| board::update_rule(&wf.conn, codec!(wf), id, enabled, reason))
}

#[tauri::command]
pub async fn delete_rule(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.with_writable(|wf| board::delete_rule(&wf.conn, id))
}

#[tauri::command]
pub async fn resolve_twin_candidates(
    state: State<'_, AppState>,
    register: Vec<Vec<i64>>,
    dismiss: Vec<Vec<i64>>,
) -> AppResult<()> {
    state.with_writable(|wf| {
        board::resolve_twin_candidates(&mut wf.conn, codec!(wf), &register, &dismiss)
    })
}

#[tauri::command]
pub async fn export_xlsx(state: State<'_, AppState>, path: String) -> AppResult<ExportReport> {
    let mut target = PathBuf::from(&path);
    if target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("xlsx"))
        != Some(true)
    {
        let mut name = target
            .file_name()
            .map(|s| s.to_os_string())
            .unwrap_or_default();
        name.push(".xlsx");
        target.set_file_name(name);
    }
    state.with_file(|wf| {
        if target == wf.path {
            return Err(AppError::InvalidInput(
                "작업 파일 자리에 저장할 수 없습니다.".into(),
            ));
        }
        export::export_xlsx(&wf.conn, codec!(wf), &target)
    })
}

// ───────────── 암호화 ─────────────

fn same_file(wf: &WorkFile, path: &Path) -> AppResult<()> {
    if wf.path != path {
        return Err(AppError::Other(
            "작업 중 파일이 바뀌었습니다. 다시 시도해 주세요.".into(),
        ));
    }
    Ok(())
}

/// 비밀번호를 넣어 잠긴 파일을 연다. 만든 키는 파일을 닫을 때까지 메모리에 둔다.
#[tauri::command]
pub async fn unlock_work_file(
    state: State<'_, AppState>,
    password: String,
) -> AppResult<WorkspaceInfo> {
    let (path, header) = state.with_file_even_locked(|wf| {
        if !wf.locked() {
            return Err(AppError::InvalidInput("이미 열려 있는 파일입니다.".into()));
        }
        let h = crypto::header(&wf.conn)?
            .ok_or_else(|| AppError::Crypto("암호화 설정이 없습니다.".into()))?;
        Ok((wf.path.clone(), h))
    })?;
    // 키 계산(수백 밀리초)은 DB 잠금 밖에서 한다.
    let cipher = crypto::unlock(&header, &password)?;
    state.with_file_even_locked(|wf| {
        same_file(wf, &path)?;
        wf.cipher = Some(cipher);
        workspace_info(wf)
    })
}

/// 암호 걸기: 새 salt로 키를 만들고 모든 대상 칸을 한꺼번에 암호화한다.
#[tauri::command]
pub async fn enable_encryption(
    state: State<'_, AppState>,
    password: String,
) -> AppResult<WorkspaceInfo> {
    let path = state.with_writable(|wf| {
        if wf.encrypted {
            return Err(AppError::InvalidInput("이미 암호가 걸려 있습니다.".into()));
        }
        Ok(wf.path.clone())
    })?;
    let (salt, cipher) = crypto::prepare_new_key(&password)?;
    state.with_writable(|wf| {
        same_file(wf, &path)?;
        crypto::enable(&mut wf.conn, &salt, &cipher)?;
        wf.encrypted = true;
        wf.cipher = Some(cipher);
        workspace_info(wf)
    })
}

/// 암호 풀기: 비밀번호를 다시 확인한 뒤 모든 대상 칸을 한꺼번에 복호화한다.
#[tauri::command]
pub async fn disable_encryption(
    state: State<'_, AppState>,
    password: String,
) -> AppResult<WorkspaceInfo> {
    let (path, header) = state.with_writable(|wf| {
        let h = crypto::header(&wf.conn)?
            .ok_or_else(|| AppError::InvalidInput("암호가 걸려 있지 않습니다.".into()))?;
        Ok((wf.path.clone(), h))
    })?;
    let cipher = crypto::unlock(&header, &password)?;
    state.with_writable(|wf| {
        same_file(wf, &path)?;
        crypto::disable(&mut wf.conn, &cipher)?;
        wf.encrypted = false;
        wf.cipher = None;
        workspace_info(wf)
    })
}

/// 암호 변경: 지금 비밀번호를 확인하고 새 비밀번호(새 salt)로 모든 자료를 다시 암호화한다.
#[tauri::command]
pub async fn change_password(
    state: State<'_, AppState>,
    current: String,
    new_password: String,
) -> AppResult<WorkspaceInfo> {
    if current == new_password {
        return Err(AppError::InvalidInput(
            "새 비밀번호가 지금 비밀번호와 같습니다.".into(),
        ));
    }
    let (path, header) = state.with_writable(|wf| {
        let h = crypto::header(&wf.conn)?
            .ok_or_else(|| AppError::InvalidInput("암호가 걸려 있지 않습니다.".into()))?;
        Ok((wf.path.clone(), h))
    })?;
    // 지금 비밀번호 확인과 새 키 계산은 DB 잠금 밖에서 한다.
    let current_cipher = crypto::unlock(&header, &current)?;
    let (salt, new_cipher) = crypto::prepare_new_key(&new_password)?;
    state.with_writable(|wf| {
        same_file(wf, &path)?;
        crypto::change_password(&mut wf.conn, &current_cipher, &salt, &new_cipher)?;
        wf.cipher = Some(new_cipher);
        workspace_info(wf)
    })
}

// ───────────── 운영체제 연동(M8) ─────────────

/// 더블클릭·끌어다 놓기(아이콘)·두 번째 실행으로 받은 `.mix` 경로를 한 번만 꺼내 준다.
#[tauri::command]
pub async fn take_launch_file(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let mut p = state
        .pending_open
        .lock()
        .map_err(|_| AppError::Other("내부 잠금 오류".into()))?;
    Ok(p.take().map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn file_association_status() -> AppResult<AssociationStatus> {
    Ok(os_integration::file_association_status())
}

#[tauri::command]
pub async fn register_file_association() -> AppResult<AssociationStatus> {
    os_integration::register()?;
    Ok(os_integration::file_association_status())
}

#[tauri::command]
pub async fn unregister_file_association() -> AppResult<AssociationStatus> {
    os_integration::unregister()?;
    Ok(os_integration::file_association_status())
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

    /// 샘플을 가져와 암호를 건 작업 파일을 연 상태(잠김)
    fn locked_state() -> (tempfile::TempDir, PathBuf, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("잠김.mix");
        let mut conn = db::create_new(&path, "t").unwrap();
        let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sample.xlsx");
        let plan = xlsx_import::plan_import("sample.xlsx", xlsx_import::parse_roster(&fx).unwrap())
            .unwrap();
        xlsx_import::apply_import(
            &mut conn,
            crypto::PLAIN,
            "sample.xlsx",
            &std::fs::read(&fx).unwrap(),
            &plan,
        )
        .unwrap();
        let (salt, cipher) = crypto::prepare_new_key(TEST_PASSWORD).unwrap();
        crypto::enable(&mut conn, &salt, &cipher).unwrap();
        drop(conn);
        let (conn, _) = db::open_existing(&path).unwrap();
        let state = AppState::default();
        *state.file.lock().unwrap() = Some(WorkFile::new(path.clone(), conn, false).unwrap());
        (dir, path, state)
    }

    const TEST_PASSWORD: &str = "교무실-비밀번호-2026";

    #[test]
    fn locked_file_refuses_every_data_command_until_unlocked() {
        let (_d, _p, state) = locked_state();
        // 잠긴 동안: 일반 동작은 모두 Locked
        assert!(matches!(state.with_file(|_| Ok(())), Err(AppError::Locked)));
        assert!(matches!(
            state.with_writable(|_| Ok(())),
            Err(AppError::Locked)
        ));
        // 화면이 잠김을 알 수 있도록 정보는 읽힌다(학생 자료는 없음)
        let info = state
            .with_file_even_locked(|wf| workspace_info(wf))
            .unwrap();
        assert!(info.encrypted && info.locked);
        assert_eq!(info.student_count, 240);
        assert_eq!(info.xlsx_file_name.as_deref(), Some("sample.xlsx"));

        // 비밀번호로 연 뒤에는 동작하고 자료가 읽힌다
        let header = state
            .with_file_even_locked(|wf| Ok(crypto::header(&wf.conn)?.unwrap()))
            .unwrap();
        assert!(matches!(
            crypto::unlock(&header, "틀린-비밀번호-입니다"),
            Err(AppError::WrongPassword)
        ));
        let cipher = crypto::unlock(&header, TEST_PASSWORD).unwrap();
        state
            .with_file_even_locked(|wf| {
                wf.cipher = Some(cipher);
                Ok(())
            })
            .unwrap();
        let students = state
            .with_file(|wf| roster::list_students(&wf.conn, codec!(wf)))
            .unwrap();
        assert_eq!(students.len(), 240);
        assert!(students.iter().any(|s| s.name == "GRACE BRIAR"));
        let info = state.with_file(|wf| workspace_info(wf)).unwrap();
        assert!(info.encrypted && !info.locked);
    }

    #[test]
    fn closing_drops_the_key_and_reopening_locks_again() {
        let (_d, path, state) = locked_state();
        let header = state
            .with_file_even_locked(|wf| Ok(crypto::header(&wf.conn)?.unwrap()))
            .unwrap();
        let cipher = crypto::unlock(&header, TEST_PASSWORD).unwrap();
        state
            .with_file_even_locked(|wf| {
                wf.cipher = Some(cipher);
                Ok(())
            })
            .unwrap();
        state.close();
        assert!(matches!(
            state.with_file(|_| Ok(())),
            Err(AppError::NoOpenFile)
        ));
        // 다시 열면 키 없이 시작한다(잠김)
        let (conn, _) = db::open_existing(&path).unwrap();
        *state.file.lock().unwrap() = Some(WorkFile::new(path.clone(), conn, false).unwrap());
        assert!(matches!(state.with_file(|_| Ok(())), Err(AppError::Locked)));
    }

    #[test]
    fn read_only_encrypted_file_can_be_unlocked_but_not_changed() {
        let (_d, path, state) = locked_state();
        state.close();
        let conn =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        *state.file.lock().unwrap() = Some(WorkFile::new(path.clone(), conn, true).unwrap());
        let header = state
            .with_file_even_locked(|wf| Ok(crypto::header(&wf.conn)?.unwrap()))
            .unwrap();
        let cipher = crypto::unlock(&header, TEST_PASSWORD).unwrap();
        state
            .with_file_even_locked(|wf| {
                wf.cipher = Some(cipher);
                Ok(())
            })
            .unwrap();
        // 읽기는 되고, 바꾸는 동작은 ReadOnly
        assert_eq!(
            state
                .with_file(|wf| roster::list_students(&wf.conn, codec!(wf)))
                .unwrap()
                .len(),
            240
        );
        assert!(matches!(
            state.with_writable(|_| Ok(())),
            Err(AppError::ReadOnly)
        ));
    }

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
