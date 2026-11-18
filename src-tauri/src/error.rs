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
    #[error("파일을 읽거나 쓰는 중 오류가 발생했습니다: {0}")]
    Io(#[from] std::io::Error),
    #[error("데이터베이스 오류: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("엑셀 파일을 읽을 수 없습니다: {0}")]
    Xlsx(String),
    #[error("{0}")]
    Other(String),
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
