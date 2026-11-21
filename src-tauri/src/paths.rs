//! 경로 이름과 확장자를 다루는 작은 도우미.

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use same_file::Handle;

/// 경로의 마지막 이름(파일 이름). 없으면 빈 문자열.
pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 확장자가 `extension`인지(대소문자 무시).
pub fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

/// 확장자가 `extension`이 아니면 이름 뒤에 덧붙인다.
pub fn ensure_extension(path: &str, extension: &str) -> PathBuf {
    let mut p = PathBuf::from(path);
    if !has_extension(&p, extension) {
        let mut name = p.file_name().map(|s| s.to_os_string()).unwrap_or_default();
        name.push(format!(".{extension}"));
        p.set_file_name(name);
    }
    p
}

/// 저장 대상이 이미 열려 있는 파일과 같은지 확인한다. 대상이 없으면 새 파일로 저장할 수 있다.
pub fn is_same_file(current: &Path, target: &Path) -> io::Result<bool> {
    if current == target {
        return Ok(true);
    }
    let metadata = match target.metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    // 파이프 등 일반 파일이 아닌 경로는 비교를 위해 열지 않는다.
    if !metadata.is_file() {
        return Ok(false);
    }
    Ok(Handle::from_path(current)? == Handle::from_path(target)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::FILE_EXTENSION;

    #[test]
    fn appends_mix_extension() {
        assert_eq!(
            ensure_extension("/a/b", FILE_EXTENSION),
            PathBuf::from("/a/b.mix")
        );
        assert_eq!(
            ensure_extension("/a/b.MIX", FILE_EXTENSION),
            PathBuf::from("/a/b.MIX")
        );
        assert_eq!(
            ensure_extension("/a/2026 2학년.v1", FILE_EXTENSION),
            PathBuf::from("/a/2026 2학년.v1.mix")
        );
    }

    #[test]
    fn file_name_of_root_is_empty() {
        assert_eq!(file_name(Path::new("/a/b.mix")), "b.mix");
        assert_eq!(file_name(Path::new("/")), "");
    }
}
