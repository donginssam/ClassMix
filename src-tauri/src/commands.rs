//! 프런트엔드에서 호출하는 Tauri 커맨드.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, params};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::board::{self, BoardData, NewRule};
use crate::changes::{self, ChangeSet, HistoryCache};
use crate::crypto::{self, Cipher, Codec};
use crate::db::{self, FILE_EXTENSION};
use crate::error::{AppError, AppResult};
use crate::export::{self, ExportReport};
use crate::os_integration::{self, AssociationStatus};
use crate::paths::{
    StagedFile, ensure_extension, file_name, has_extension, is_same_file, read_document,
};
use crate::roster::{self, PdfApplyReport, PdfLink, PdfRowInput};
use crate::settings::{self, RecentFile};
use crate::xlsx_import::{self, ImportReport};

static NEXT_ROSTER_GENERATION: AtomicU64 = AtomicU64::new(1);
const MAX_PDF_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PDF_ROWS: usize = 10_000;

pub struct WorkFile {
    pub path: PathBuf,
    file_identity: same_file::Handle,
    pub conn: Connection,
    pub read_only: bool,
    /// 암호가 걸린 파일인지(meta에 salt가 있음)
    pub encrypted: bool,
    /// 비밀번호로 만든 키. 파일을 연 동안만 메모리에 두고, 닫으면 버린다(키 내용은 지워짐).
    pub cipher: Option<Cipher>,
    /// 보드를 다시 읽을 때 이력 복호화·파싱을 줄이는 캐시. 파일을 닫으면 함께 버린다.
    pub history_cache: HistoryCache,
    /// 현재 반·번호·한글 표기 이외의 학생 자료가 바뀌거나 파일을 다시 열면 갱신한다.
    roster_generation: u64,
}

impl WorkFile {
    fn new(path: PathBuf, conn: Connection, read_only: bool) -> AppResult<Self> {
        let encrypted = crypto::header(&conn)?.is_some();
        let file_identity = same_file::Handle::from_path(&path)?;
        Ok(Self {
            path,
            file_identity,
            conn,
            read_only,
            encrypted,
            cipher: None,
            history_cache: HistoryCache::default(),
            roster_generation: NEXT_ROSTER_GENERATION.fetch_add(1, Ordering::Relaxed),
        })
    }

    fn invalidate_roster(&mut self) {
        self.roster_generation = NEXT_ROSTER_GENERATION.fetch_add(1, Ordering::Relaxed);
    }

    fn locked(&self) -> bool {
        self.encrypted && self.cipher.is_none()
    }

    /// 지금 열린 파일 자리에 덮어쓰지 않도록 막는다.
    fn ensure_not_current(&self, target: &Path, message: &str) -> AppResult<()> {
        if is_same_file(&self.path, target)? {
            return Err(AppError::InvalidInput(message.into()));
        }
        Ok(())
    }

    fn copy_to(&self, target: &Path) -> AppResult<()> {
        self.ensure_not_current(
            target,
            "지금 열려 있는 작업 파일에는 사본을 저장할 수 없습니다.",
        )?;
        db::vacuum_into(&self.conn, target)
    }

    fn save_as(&mut self, target: &Path) -> AppResult<WorkspaceInfo> {
        self.copy_to(target)?;
        let (conn, outcome) = db::open_existing(target)?;
        conn.execute(
            "UPDATE meta SET opened_by = ?1, opened_at = ?2, updated_at = ?2 WHERE id = 1",
            params![host_name(), db::now()],
        )?;
        let mut next = Self::new(target.to_path_buf(), conn, outcome.read_only)?;
        let mut info = workspace_info(&next)?;
        // 사본을 열 준비가 끝나면 같은 키를 넘겨 비밀번호를 다시 묻지 않는다.
        next.cipher = self.cipher.take();
        info.locked = next.locked();
        self.clear_open_marker();
        *self = next;
        Ok(info)
    }

    fn clear_open_marker(&self) {
        if !self.read_only {
            let _ = self.conn.execute(
                "UPDATE meta SET opened_by = NULL, opened_at = NULL WHERE id = 1",
                [],
            );
        }
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
        self.with_file_even_locked(|wf| {
            if wf.locked() {
                return Err(AppError::Locked);
            }
            f(wf)
        })
    }

    /// 잠긴 파일이어도 부르는 동작(비밀번호 입력 등)
    fn with_file_even_locked<T>(
        &self,
        f: impl FnOnce(&mut WorkFile) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self.lock_file()?;
        let wf = guard.as_mut().ok_or(AppError::NoOpenFile)?;
        f(wf)
    }

    /// 배치 외 학생 자료를 바꿀 수 있는 쓰기 경로.
    fn with_writable<T>(&self, f: impl FnOnce(&mut WorkFile) -> AppResult<T>) -> AppResult<T> {
        self.with_writable_file(|wf| {
            wf.invalidate_roster();
            f(wf)
        })
    }

    /// 학생 자료의 버전을 유지하는 호출부는 배치 조회에 포함된 값만 바꿀 수 있다.
    fn with_writable_file<T>(&self, f: impl FnOnce(&mut WorkFile) -> AppResult<T>) -> AppResult<T> {
        self.with_file(|wf| {
            if wf.read_only {
                return Err(AppError::ReadOnly);
            }
            f(wf)
        })
    }

    fn lock_file(&self) -> AppResult<MutexGuard<'_, Option<WorkFile>>> {
        self.file
            .lock()
            .map_err(|_| AppError::Other("내부 잠금 오류".into()))
    }

    /// 열린 파일을 닫는다(열림 표시를 지움).
    pub fn close(&self) {
        if let Ok(mut guard) = self.lock_file()
            && let Some(wf) = guard.take()
        {
            wf.clear_open_marker();
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
    let (title, target_grade, class_count, created_at, updated_at): (_, _, Option<i64>, _, _) = c
        .query_row(
        "SELECT title, target_grade, class_count, created_at, updated_at FROM meta WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    if class_count.is_some_and(|n| !(1..=xlsx_import::MAX_CLASS_COUNT).contains(&n)) {
        return Err(AppError::InvalidInput(
            "작업 파일의 반 수가 지원 범위를 벗어났습니다.".into(),
        ));
    }
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
        file_name: file_name(&wf.path),
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
    let path = ensure_extension(&path, FILE_EXTENSION);
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
    *state.lock_file()? = Some(wf);
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
    let wf = WorkFile::new(path.clone(), conn, outcome.read_only)?;
    let workspace = workspace_info(&wf)?;
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
            wf.conn
                .query_row("SELECT opened_by FROM meta WHERE id = 1", [], |r| r.get(0))?;
        let me = host_name();
        if let Some(other) = opened_by.filter(|h| *h != me) {
            warnings.push(format!(
                "이 파일이 다른 PC({other})에서 열려 있거나, 그 PC에서 제대로 닫히지 않았습니다. 두 곳에서 동시에 고치면 변경 내용이 섞일 수 있습니다."
            ));
        }
        wf.conn.execute(
            "UPDATE meta SET opened_by = ?1, opened_at = ?2 WHERE id = 1",
            params![me, db::now()],
        )?;
    }
    *state.lock_file()? = Some(wf);
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    workspace: WorkspaceInfo,
    board: Option<BoardData>,
    roster_version: Option<String>,
}

fn workspace_snapshot(
    state: &AppState,
    include_history: bool,
    known_roster_version: Option<&str>,
) -> AppResult<Option<WorkspaceSnapshot>> {
    let mut guard = state.lock_file()?;
    let Some(wf) = guard.as_mut() else {
        return Ok(None);
    };
    if !include_history {
        wf.history_cache = HistoryCache::default();
    }
    let data_version = || -> rusqlite::Result<i64> {
        wf.conn
            .pragma_query_value(None, "data_version", |row| row.get(0))
    };
    let before = data_version()?;
    let tx = wf.conn.unchecked_transaction()?;
    let workspace = workspace_info(wf)?;
    let current = data_version()?;
    // 외부 연결이 읽기 트랜잭션 시작 전에 쓰면 학생 자료 전체를 다시 보낸다.
    let roster_version = (!workspace.locked && before == current)
        .then(|| format!("{}:{current}", wf.roster_generation));
    let placements_only =
        roster_version.is_some() && roster_version.as_deref() == known_roster_version;
    let board = (!workspace.locked)
        .then(|| {
            board::board_data_cached(
                &tx,
                codec!(wf),
                include_history.then_some(&mut wf.history_cache),
                placements_only,
            )
        })
        .transpose()?;
    tx.commit()?;
    Ok(Some(WorkspaceSnapshot {
        workspace,
        board,
        roster_version,
    }))
}

#[tauri::command]
pub async fn get_workspace_snapshot(
    state: State<'_, AppState>,
    include_history: Option<bool>,
    known_roster_version: Option<String>,
) -> AppResult<Option<WorkspaceSnapshot>> {
    workspace_snapshot(
        &state,
        include_history.unwrap_or(true),
        known_roster_version.as_deref(),
    )
}

/// 다른 이름으로 저장: 사본을 만들고 그 파일로 전환한다.
#[tauri::command]
pub async fn save_work_file_as(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<WorkspaceInfo> {
    let target = ensure_extension(&path, FILE_EXTENSION);
    let info = state.with_file(|wf| wf.save_as(&target))?;
    remember(&app, &target);
    Ok(info)
}

/// 사본 저장(백업): 지금 파일은 그대로 두고 사본만 만든다.
#[tauri::command]
pub async fn save_work_file_copy(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let target = ensure_extension(&path, FILE_EXTENSION);
    state.with_file(|wf| {
        wf.copy_to(&target)?;
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
    let file_name = file_name(&src);
    let bytes = xlsx_import::read_xlsx_file(&src)?;
    let plan = xlsx_import::plan_import(&file_name, xlsx_import::parse_roster_bytes(&bytes)?)?;
    state.with_writable(|wf| {
        xlsx_import::apply_import(&mut wf.conn, codec!(wf), &file_name, &bytes, &plan)?;
        Ok(ImportXlsxResult {
            report: plan.report.clone(),
            workspace: workspace_info(wf)?,
        })
    })
}

/// PDF 파일 내용을 그대로 돌려준다(프런트엔드에서 pdf.js로 파싱).
#[tauri::command]
pub async fn read_pdf_file(path: String) -> AppResult<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(read_pdf(Path::new(&path))?))
}

fn read_pdf(path: &Path) -> AppResult<Vec<u8>> {
    if !has_extension(path, "pdf") {
        return Err(AppError::InvalidInput("PDF 파일이 아닙니다.".into()));
    }
    read_document(path, MAX_PDF_BYTES, "PDF")
}

#[tauri::command]
pub async fn apply_pdf_mapping(
    state: State<'_, AppState>,
    path: String,
    rows: Vec<PdfRowInput>,
    links: Vec<PdfLink>,
) -> AppResult<PdfApplyReport> {
    if rows.len() > MAX_PDF_ROWS || links.len() > rows.len() {
        return Err(AppError::InvalidInput(
            "반영할 PDF 학생 행 또는 연결이 너무 많습니다.".into(),
        ));
    }
    let src = PathBuf::from(&path);
    let file_name = file_name(&src);
    let bytes = read_pdf(&src)?;
    state.with_writable(|wf| {
        roster::apply_pdf(&mut wf.conn, codec!(wf), &file_name, &bytes, &rows, &links)
    })
}

// ───────────── 반편성 보드(M4~M7) ─────────────

#[tauri::command]
pub async fn apply_change(state: State<'_, AppState>, change: ChangeSet) -> AppResult<()> {
    // 변경 묶음이 바꾸는 학생 값은 모두 배치 조회에 포함된다.
    state.with_writable_file(|wf| changes::apply_change(&mut wf.conn, codec!(wf), &change))
}

#[tauri::command]
pub async fn undo_change(state: State<'_, AppState>) -> AppResult<Option<String>> {
    state.with_writable_file(|wf| changes::undo(&mut wf.conn, codec!(wf)))
}

#[tauri::command]
pub async fn redo_change(state: State<'_, AppState>) -> AppResult<Option<String>> {
    state.with_writable_file(|wf| changes::redo(&mut wf.conn, codec!(wf)))
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
    let target = ensure_extension(&path, "xlsx");
    state.with_file(|wf| {
        wf.ensure_not_current(&target, "작업 파일 자리에 저장할 수 없습니다.")?;
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
        wf.invalidate_roster();
        workspace_info(wf)
    })
}

/// 암호 설정: 새 salt로 키를 만들고 모든 대상 칸을 한꺼번에 암호화한다.
#[tauri::command]
pub async fn enable_encryption(
    state: State<'_, AppState>,
    password: String,
) -> AppResult<WorkspaceInfo> {
    let (path, generation) = state.with_file(|wf| {
        if wf.read_only {
            return Err(AppError::ReadOnly);
        }
        if wf.encrypted {
            return Err(AppError::InvalidInput("이미 암호가 걸려 있습니다.".into()));
        }
        Ok((wf.path.clone(), wf.roster_generation))
    })?;
    let (salt, cipher) = crypto::prepare_new_key(&password)?;
    enable_workspace_encryption(&state, path, generation, &salt, cipher)
}

fn enable_workspace_encryption(
    state: &AppState,
    path: PathBuf,
    generation: u64,
    salt: &[u8],
    cipher: Cipher,
) -> AppResult<WorkspaceInfo> {
    let mut guard = state.lock_file()?;
    let wf = guard.as_ref().ok_or(AppError::NoOpenFile)?;
    same_file(wf, &path)?;
    if wf.roster_generation != generation || wf.encrypted || wf.read_only {
        return Err(AppError::InvalidInput(
            "작업 중 파일이 바뀌었습니다. 다시 시도해 주세요.".into(),
        ));
    }
    if wf.file_identity != same_file::Handle::from_path(&path)? {
        return Err(workspace_changed_externally());
    }
    let data_version = || {
        wf.conn
            .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
    };
    let version = data_version()?;
    let staged = StagedFile::new(&path)?;
    crypto::stage_encryption(&wf.conn, &staged, salt, &cipher)?;
    if data_version()? != version || wf.file_identity != same_file::Handle::from_path(&path)? {
        return Err(workspace_changed_externally());
    }

    // Windows에서는 열린 DB를 교체할 수 없다. 실패하면 기존 파일에 다시 연결한다.
    drop(guard.take());
    let published = staged.publish();
    let mut next = reopen_after_replace(path, published.is_ok())?;
    let verification = if published.is_ok() {
        crypto::verify_key(&next.conn, &cipher)
    } else {
        Ok(false)
    };
    if matches!(verification, Ok(true)) {
        next.cipher = Some(cipher);
    }
    *guard = Some(next);
    published?;
    if !verification? {
        return Err(AppError::Crypto(
            "저장한 파일의 비밀번호를 확인하지 못했습니다. 다시 열어 주세요.".into(),
        ));
    }
    workspace_info(guard.as_ref().ok_or(AppError::NoOpenFile)?)
}

/// 교체한(또는 교체하지 못한) 작업 파일을 다시 연다. 다시 열지 못하면 이미 닫힌 상태이므로
/// 프런트엔드가 화면을 정리하도록 `FileClosed`로 알린다.
fn reopen_after_replace(path: PathBuf, replaced: bool) -> AppResult<WorkFile> {
    db::open_existing(&path)
        .and_then(|(conn, outcome)| WorkFile::new(path, conn, outcome.read_only))
        .map_err(|e| {
            let done = if replaced {
                "암호는 설정되었지만"
            } else {
                "암호를 설정하지 못했고"
            };
            AppError::FileClosed(format!(
                "{done} 작업 파일을 다시 열지 못해 닫았습니다. 파일을 다시 열어 주세요. ({e})"
            ))
        })
}

fn workspace_changed_externally() -> AppError {
    AppError::InvalidInput("다른 곳에서 작업 파일이 바뀌었습니다. 다시 열어 주세요.".into())
}

/// 암호 해제: 비밀번호를 다시 확인한 뒤 모든 대상 칸을 한꺼번에 복호화한다.
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

/// 암호 변경: 현재 비밀번호를 확인하고 새 비밀번호(새 salt)로 모든 자료를 다시 암호화한다.
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
    fn failed_reopen_after_replace_reports_a_closed_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("사라진 파일.mix");
        let Err(AppError::FileClosed(message)) = reopen_after_replace(missing.clone(), true) else {
            panic!("다시 열지 못하면 닫힌 파일로 알려야 합니다.");
        };
        assert!(message.contains("암호는 설정되었지만"), "{message}");
        let Err(err) = reopen_after_replace(missing, false) else {
            panic!("다시 열지 못하면 오류여야 합니다.");
        };
        assert_eq!(err.code(), "file_closed");
        assert!(err.to_string().contains("암호를 설정하지 못했고"));
    }

    #[test]
    fn enabling_workspace_encryption_keeps_the_work_file_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("새 작업.mix");
        let conn = db::create_new(&path, "새 작업").unwrap();
        let wf = WorkFile::new(path.clone(), conn, false).unwrap();
        let generation = wf.roster_generation;
        let state = AppState {
            file: Mutex::new(Some(wf)),
            ..AppState::default()
        };
        let (salt, cipher) = crypto::prepare_new_key(TEST_PASSWORD).unwrap();
        let info =
            enable_workspace_encryption(&state, path.clone(), generation, &salt, cipher).unwrap();
        assert!(info.encrypted && !info.locked);
        assert_eq!(info.title, "새 작업");
        state.close();

        let (conn, _) = db::open_existing(&path).unwrap();
        assert!(WorkFile::new(path, conn, false).unwrap().locked());
    }

    #[test]
    fn workspace_snapshot_reads_history_details_only_when_requested() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.mix");
        let conn = db::create_new(&path, "t").unwrap();
        let payload =
            r#"{"action":"move","label":"반 이동","students":[],"gaps":[],"numbering":[]}"#;
        conn.execute(
            "INSERT INTO change_log (id, seq, action, payload, undone, created_at)
             VALUES (1, 1, 'move', ?1, 0, '2026-01-01')",
            [payload],
        )
        .unwrap();
        let state = AppState::default();
        *state.file.lock().unwrap() = Some(WorkFile::new(path, conn, false).unwrap());

        let board = workspace_snapshot(&state, false, None)
            .unwrap()
            .unwrap()
            .board
            .unwrap();
        assert!(board.history.is_none());
        assert!(board.can_undo && !board.can_redo);

        let board = workspace_snapshot(&state, true, None)
            .unwrap()
            .unwrap()
            .board
            .unwrap();
        assert_eq!(board.history.unwrap()[0].label, "반 이동");
        state
            .with_file(|wf| {
                wf.conn.execute(
                    "UPDATE change_log SET payload = 'invalid JSON', undone = 1 WHERE id = 1",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let board = workspace_snapshot(&state, false, None)
            .unwrap()
            .unwrap()
            .board
            .unwrap();
        assert!(board.history.is_none());
        assert!(!board.can_undo && board.can_redo);
        assert!(workspace_snapshot(&state, true, None).is_err());
    }

    #[test]
    fn workspace_snapshot_reuses_roster_for_placement_edits_until_other_data_changes() {
        let (_dir, path, state) = locked_state();
        state
            .with_file_even_locked(|wf| {
                let header = crypto::header(&wf.conn)?.unwrap();
                wf.cipher = Some(crypto::unlock(&header, TEST_PASSWORD)?);
                Ok(())
            })
            .unwrap();
        let initial = workspace_snapshot(&state, false, None).unwrap().unwrap();
        let version = initial.roster_version.as_deref();
        let students = initial.board.unwrap().students.unwrap();
        let student = students.iter().find(|s| s.name == "GRACE BRIAR").unwrap();
        let id = student.id;
        let reading = ChangeSet {
            action: "set_reading".into(),
            label: "한글 표기".into(),
            students: vec![],
            gaps: vec![],
            numbering: vec![],
            readings: vec![changes::ReadingChange {
                student_id: id,
                from: student.sort_name.clone(),
                to: Some("그레이스".into()),
            }],
        };
        state
            .with_writable_file(|wf| changes::apply_change(&mut wf.conn, codec!(wf), &reading))
            .unwrap();
        let snapshot = workspace_snapshot(&state, true, version).unwrap().unwrap();
        assert_eq!(snapshot.roster_version.as_deref(), version);
        let board = snapshot.board.unwrap();
        assert!(board.students.is_none());
        let places = board.student_placements.unwrap();
        assert_eq!(places.len(), students.len());
        assert_eq!(
            places.iter().find(|p| p.0 == id).unwrap().3.as_deref(),
            Some("그레이스")
        );
        assert!(board.can_undo && !board.can_redo);
        assert_eq!(board.history.unwrap()[0].label, "한글 표기");

        state
            .with_writable_file(|wf| changes::undo(&mut wf.conn, codec!(wf)))
            .unwrap();
        let board = workspace_snapshot(&state, false, version)
            .unwrap()
            .unwrap()
            .board
            .unwrap();
        assert_eq!(
            board
                .student_placements
                .unwrap()
                .into_iter()
                .find(|p| p.0 == id)
                .unwrap()
                .3,
            student.sort_name
        );
        assert!(!board.can_undo && board.can_redo);

        state
            .with_writable(|wf| board::set_memo(&wf.conn, codec!(wf), id, Some("메모".into())))
            .unwrap();
        let snapshot = workspace_snapshot(&state, false, version).unwrap().unwrap();
        assert_ne!(snapshot.roster_version.as_deref(), version);
        let list = snapshot.board.unwrap().students.unwrap();
        assert_eq!(
            list.iter().find(|s| s.id == id).unwrap().memo.as_deref(),
            Some("메모")
        );

        Connection::open(path)
            .unwrap()
            .execute("UPDATE student SET gender = '남' WHERE id = ?1", [id])
            .unwrap();
        let fresh = workspace_snapshot(&state, false, snapshot.roster_version.as_deref())
            .unwrap()
            .unwrap();
        assert_ne!(fresh.roster_version, snapshot.roster_version);
        let list = fresh.board.unwrap().students.unwrap();
        assert_eq!(
            list.iter().find(|s| s.id == id).unwrap().gender.as_deref(),
            Some("남")
        );
    }

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
        let snapshot = workspace_snapshot(&state, true, None).unwrap().unwrap();
        assert!(snapshot.board.is_none());
        let info = snapshot.workspace;
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
        let snapshot = workspace_snapshot(&state, true, None).unwrap().unwrap();
        assert_eq!(snapshot.board.unwrap().students.unwrap().len(), 240);
        assert!(snapshot.workspace.encrypted && !snapshot.workspace.locked);
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
    fn copying_work_file_rejects_another_path_to_the_same_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("original.mix");
        let conn = db::create_new(&path, "t").unwrap();
        let wf = WorkFile::new(path.clone(), conn, false).unwrap();
        let subdir = dir.path().join("subdir");
        std::fs::create_dir(&subdir).unwrap();
        let alternate_path = subdir.join("..").join("original.mix");
        assert_ne!(path, alternate_path);

        assert!(matches!(
            wf.copy_to(&alternate_path),
            Err(AppError::InvalidInput(_))
        ));
        let case_variant = path.with_file_name("ORIGINAL.mix");
        if case_variant.exists() {
            assert!(matches!(
                wf.copy_to(&case_variant),
                Err(AppError::InvalidInput(_))
            ));
        }
        let backup = dir.path().join("backup.mix");
        wf.copy_to(&backup).unwrap();
        assert!(backup.is_file());
    }

    #[test]
    fn save_as_switches_files_only_after_copy_succeeds_and_keeps_the_key() {
        let (dir, path, state) = locked_state();
        state
            .with_file_even_locked(|wf| {
                let header = crypto::header(&wf.conn)?.unwrap();
                wf.cipher = Some(crypto::unlock(&header, TEST_PASSWORD)?);
                wf.conn
                    .execute("UPDATE meta SET opened_by = 'test' WHERE id = 1", [])?;
                Ok(())
            })
            .unwrap();

        let invalid = dir.path().join("no-such-directory").join("copy.mix");
        assert!(state.with_file(|wf| wf.save_as(&invalid)).is_err());
        assert_eq!(state.with_file(|wf| Ok(wf.path.clone())).unwrap(), path);

        let target = dir.path().join("copy.mix");
        let info = state.with_file(|wf| wf.save_as(&target)).unwrap();
        assert!(info.encrypted && !info.locked);
        assert_eq!(state.with_file(|wf| Ok(wf.path.clone())).unwrap(), target);
        let snapshot = workspace_snapshot(&state, true, None).unwrap().unwrap();
        assert_eq!(snapshot.board.unwrap().students.unwrap().len(), 240);

        let previous = Connection::open(&path).unwrap();
        let opened_by: Option<String> = previous
            .query_row("SELECT opened_by FROM meta WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(opened_by.is_none());
    }
}
