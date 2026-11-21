use serde::Serialize;

/// 앱 전체에서 쓰는 오류. 프런트엔드에는 `{ code, message }` 형태로 전달된다.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("열린 작업 파일이 없습니다.")]
    NoOpenFile,
    #[error("ClassMix 작업 파일(.mix)이 아닙니다.")]
    NotClassMixFile,
    #[error("이 파일은 읽기 전용으로 열려 있어 바꿀 수 없습니다.")]
    ReadOnly,
    #[error("{0}")]
    InvalidXlsx(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{}", io_message(.0))]
    Io(#[from] std::io::Error),
    #[error("데이터베이스 오류: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("엑셀 파일을 읽을 수 없습니다: {0}")]
    Xlsx(String),
    #[error("암호가 걸린 파일입니다. 비밀번호를 입력해 열어 주세요.")]
    Locked,
    #[error("비밀번호가 맞지 않습니다.")]
    WrongPassword,
    #[error("암호화 처리 중 오류가 발생했습니다: {0}")]
    Crypto(String),
    #[error("{0}")]
    Other(String),
}

/// 교사가 바로 조치할 수 있도록 흔한 파일 오류를 풀어 쓴다.
fn io_message(e: &std::io::Error) -> String {
    use std::io::ErrorKind;
    // Windows: 32 = 다른 프로세스가 파일을 사용 중, 33 = 파일 일부가 잠김(엑셀에서 연 경우 등)
    if matches!(e.raw_os_error(), Some(32 | 33)) {
        return "다른 프로그램(엑셀 등)이 이 파일을 사용하고 있습니다. 그 프로그램에서 파일을 닫고 다시 시도하세요."
            .into();
    }
    match e.kind() {
        ErrorKind::NotFound => "파일이나 폴더를 찾을 수 없습니다. 옮겨졌거나 USB가 빠졌는지 확인하세요.".into(),
        ErrorKind::PermissionDenied => "이 위치에 쓸 권한이 없거나 파일이 다른 프로그램에서 열려 있습니다. 다른 폴더를 고르거나 파일을 닫고 다시 시도하세요.".into(),
        ErrorKind::StorageFull => "저장 공간이 부족합니다.".into(),
        ErrorKind::ReadOnlyFilesystem => "읽기 전용 위치입니다. 다른 폴더를 고르세요.".into(),
        _ => format!("파일을 읽거나 쓰는 중 오류가 발생했습니다: {e}"),
    }
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NoOpenFile => "no_open_file",
            AppError::NotClassMixFile => "not_classmix_file",
            AppError::ReadOnly => "read_only",
            AppError::InvalidXlsx(_) => "invalid_xlsx",
            AppError::InvalidInput(_) => "invalid_input",
            AppError::Io(_) => "io",
            AppError::Db(_) => "db",
            AppError::Xlsx(_) => "xlsx",
            AppError::Locked => "locked",
            AppError::WrongPassword => "wrong_password",
            AppError::Crypto(_) => "crypto",
            AppError::Other(_) => "other",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
