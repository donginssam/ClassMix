//! 경로 이름과 확장자를 다루는 작은 도우미.

use std::fs::{self, File};
use std::io::{self, ErrorKind, Read};
use std::path::{Path, PathBuf};

use same_file::Handle;

use crate::error::{AppError, AppResult};

/// 파일 크기가 읽기 도중 바뀌어도 한도까지만 읽는다.
pub fn read_document(path: &Path, limit: u64, kind: &str) -> AppResult<Vec<u8>> {
    let not_a_file = || AppError::InvalidInput(format!("{kind} 파일을 선택해 주세요."));
    if !path.is_file() {
        return Err(not_a_file());
    }
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    let too_large = || {
        AppError::InvalidInput(format!(
            "{kind} 파일은 {} MiB까지 읽을 수 있습니다.",
            limit >> 20
        ))
    };
    if !metadata.is_file() {
        return Err(not_a_file());
    }
    if metadata.len() > limit {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(too_large());
    }
    Ok(bytes)
}

/// 상위 폴더를 해석하고 마지막 경로 항목은 그대로 둔다.
pub fn resolve_parent(path: &Path) -> AppResult<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("파일 이름이 필요합니다.".into()))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(fs::canonicalize(parent)?.join(name))
}

/// 작업 파일(`.mix`)은 이 PC의 디스크(내장 디스크, USB 같은 이동식 디스크)에만 둔다.
/// 네트워크 드라이브에서는 여러 PC가 같은 파일을 동시에 열 수 있고 SQLite 잠금도 믿을 수 없다.
/// 다른 사람과는 USB로 복사해 주고받는다.
pub fn ensure_local_volume(path: &Path) -> AppResult<()> {
    let target = resolve_parent(path)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::InvalidInput("작업 파일 폴더가 필요합니다.".into()))?;
    if is_network_volume(parent)? {
        return Err(AppError::InvalidInput(
            "네트워크 드라이브에 있는 작업 파일은 열거나 저장할 수 없습니다. \
             내 PC의 디스크나 USB에 복사한 뒤 사용해 주세요."
                .into(),
        ));
    }
    Ok(())
}

/// macOS: 마운트 정보에 로컬 표시(MNT_LOCAL)가 없으면 네트워크 볼륨(SMB, NFS, AFP, WebDAV 등)이다.
#[cfg(target_os = "macos")]
fn is_network_volume(dir: &Path) -> io::Result<bool> {
    let st = statfs(dir)?;
    Ok(st.f_flags & (libc::MNT_LOCAL as u32) == 0)
}

/// Linux: 네트워크 파일시스템의 종류 번호로 판별한다(statfs(2)의 f_type).
#[cfg(target_os = "linux")]
fn is_network_volume(dir: &Path) -> io::Result<bool> {
    const NETWORK_TYPES: [i64; 9] = [
        0x6969,      // NFS
        0x517B,      // SMB
        0xFF53_4D42, // CIFS
        0xFE53_4D42, // SMB2
        0x7375_7245, // Coda
        0x5346_414F, // AFS
        0x564C,      // NCP
        0x0102_1997, // 9P
        0x00C3_6400, // Ceph
    ];
    #[allow(clippy::unnecessary_cast)] // f_type의 정수 형식은 libc 구현마다 다르다.
    let kind = statfs(dir)?.f_type as i64;
    Ok(NETWORK_TYPES.contains(&kind))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn statfs(dir: &Path) -> io::Result<libc::statfs> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(dir.as_os_str().as_bytes())?;
    // SAFETY: c_path는 NUL로 끝나는 경로이고, st는 statfs가 채울 수 있는 크기의 0으로 초기화된 구조체다.
    unsafe {
        let mut st: libc::statfs = std::mem::zeroed();
        if libc::statfs(c_path.as_ptr(), &mut st) != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(st)
    }
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn is_network_volume(_dir: &Path) -> io::Result<bool> {
    Ok(false)
}

/// Windows: UNC 경로(`\\서버\공유`, 매핑한 네트워크 드라이브도 정규화하면 이렇게 바뀐다)와
/// 드라이브 종류가 네트워크(DRIVE_REMOTE)인 드라이브를 거부한다. 판별할 수 없는 형식도 거부한다.
#[cfg(windows)]
fn is_network_volume(dir: &Path) -> io::Result<bool> {
    use std::path::{Component, Prefix};
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_REMOTE: u32 = 4;
    let Some(Component::Prefix(prefix)) = dir.components().next() else {
        return Ok(true);
    };
    match prefix.kind() {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
            let root: Vec<u16> = format!("{}:\\", char::from(letter))
                .encode_utf16()
                .chain([0])
                .collect();
            // SAFETY: root는 NUL로 끝나는 UTF-16 드라이브 루트 경로다.
            Ok(unsafe { GetDriveTypeW(root.as_ptr()) } == DRIVE_REMOTE)
        }
        _ => Ok(true),
    }
}

/// 같은 파일시스템에 전용 임시 디렉터리와 독점 파일을 만든다.
/// 쓰기와 검사에는 열린 핸들을 쓰고, SQLite가 경로를 요구할 때만 파일 이름을 넘긴다.
pub struct StagedFile {
    #[cfg(windows)]
    file_lock: File,
    file: tempfile::NamedTempFile,
    target: PathBuf,
    #[cfg(windows)]
    _directories: Vec<File>,
    _directory: tempfile::TempDir,
}

impl StagedFile {
    pub fn new(target: &Path) -> AppResult<Self> {
        let target = resolve_parent(target)?;
        let parent = target
            .parent()
            .ok_or_else(|| AppError::InvalidInput("저장할 폴더가 필요합니다.".into()))?;
        #[cfg(unix)]
        check_staging_parent(parent)?;
        #[cfg(windows)]
        let mut directories: Vec<File> = parent
            .ancestors()
            .filter(|path| path.has_root())
            .map(|path| lock_path(path, true))
            .collect::<io::Result<_>>()?;

        let mut builder = tempfile::Builder::new();
        builder.prefix(".classmix-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o700));
        }
        let directory = builder.tempdir_in(parent)?;
        #[cfg(windows)]
        directories.push(lock_path(directory.path(), true)?);
        let file = tempfile::NamedTempFile::new_in(directory.path())?;
        #[cfg(windows)]
        let file_lock = {
            let lock = lock_path(file.path(), false)?;
            if Handle::from_file(lock.try_clone()?)?
                != Handle::from_file(file.as_file().try_clone()?)?
            {
                return Err(
                    io::Error::new(ErrorKind::InvalidData, "임시 파일이 바뀌었습니다.").into(),
                );
            }
            lock
        };
        Ok(Self {
            #[cfg(windows)]
            file_lock,
            file,
            target,
            #[cfg(windows)]
            _directories: directories,
            _directory: directory,
        })
    }

    pub fn path(&self) -> &Path {
        self.file.path()
    }

    pub fn writer(&mut self) -> &mut File {
        self.file.as_file_mut()
    }

    pub fn reopen(&self) -> io::Result<File> {
        let file = self.file.reopen()?;
        let named = Handle::from_path(self.path())?;
        if Handle::from_file(file.try_clone()?)? != named {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "임시 파일이 바뀌었습니다.",
            ));
        }
        Ok(file)
    }

    pub fn publish(self) -> AppResult<()> {
        self.reopen()?.sync_all()?;
        #[cfg(not(windows))]
        {
            self.file.persist(&self.target).map_err(|e| e.error)?;
            if let Some(parent) = self.target.parent() {
                sync_directory(parent);
            }
        }
        #[cfg(windows)]
        self.publish_by_handle()?;
        Ok(())
    }

    /// 경로로 이름을 바꾸면 잠금을 푼 순간부터 이름 변경까지 다른 사용자가 파일을 바꿔치기할 틈이 생긴다.
    /// 그래서 이름 변경 권한이 있는 핸들을 배타적으로 열어 둔 뒤, 처음 만든 파일과 같은지 확인하고 그 핸들을 사용해 교체한다.
    #[cfg(windows)]
    fn publish_by_handle(self) -> AppResult<()> {
        let Self {
            file_lock,
            file,
            target,
            _directories: directories,
            _directory: directory,
        } = self;
        let result = (|| -> AppResult<()> {
            // 임시 파일 속성을 풀고 자동 삭제를 끈다. 실패하면 아래에서 임시 폴더째 지운다.
            let (file, path) = file.keep().map_err(|e| e.error)?;
            // DELETE 권한 핸들은 다른 핸들이 모두 삭제 공유를 허용할 때만 열리므로, 잠금 핸들을 먼저 닫는다.
            // 그 사이에 파일이 바뀌면 아래 동일성 검사에서 거부한다.
            drop(file_lock);
            let mover = open_for_rename(&path)?;
            if Handle::from_file(mover.try_clone()?)? != Handle::from_file(file.try_clone()?)? {
                return Err(
                    io::Error::new(ErrorKind::InvalidData, "임시 파일이 바뀌었습니다.").into(),
                );
            }
            drop(file);
            rename_by_handle(&mover, &target)?;
            Ok(())
        })();
        // 폴더 잠금을 먼저 닫아야 임시 폴더를 지울 수 있다.
        drop(directories);
        drop(directory);
        result
    }
}

/// 이름 바꾸기(교체)를 디스크에 확정한다. 파일 내용은 교체 전에 이미 기록했으므로, 이 단계를 하지 않으면
/// 교체 직후 전원이 꺼졌을 때 이전 파일로 돌아갈 수 있다(반쯤 쓴 파일이 남지는 않는다).
/// 교체는 이미 끝났으므로 실패해도 오류로 돌려주지 않는다. 오류를 돌려주면 화면은 저장에 실패했다고
/// 알리는데 실제 파일은 바뀐 상태가 되어 서로 어긋난다.
/// 폴더 핸들은 작업 파일과 다른 파일이므로 열고 닫아도 SQLite 잠금에 영향이 없다(`FileId` 참고).
#[cfg(not(windows))]
fn sync_directory(dir: &Path) {
    if let Err(e) = File::open(dir).and_then(|d| d.sync_all()) {
        eprintln!("[ClassMix] 폴더 동기화 실패(파일은 이미 교체됨): {e}");
    }
}

#[cfg(windows)]
const FILE_READ_ATTRIBUTES: u32 = 0x80;
#[cfg(windows)]
const FILE_SHARE_READ_WRITE: u32 = 0x3;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// 이름 변경 권한(DELETE)을 가진 핸들. 삭제 공유를 허용하지 않으므로, 이 핸들이 열려 있는 동안
/// 다른 프로세스는 이 파일의 이름을 바꾸거나 지울 수 없다.
#[cfg(windows)]
fn open_for_rename(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const DELETE: u32 = 0x0001_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    fs::OpenOptions::new()
        .access_mode(DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

/// 열린 핸들의 파일을 `target`으로 옮기고, 있으면 교체한다. 표준 라이브러리 `fs::rename`과 같은 방식으로
/// POSIX 방식(FileRenameInfoEx)을 먼저 시도하고, 지원하지 않는 파일시스템에서는 FileRenameInfo를 쓴다.
#[cfg(windows)]
fn rename_by_handle(file: &File, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_INFO_BY_HANDLE_CLASS, FILE_RENAME_INFO, FileRenameInfo, FileRenameInfoEx,
        SetFileInformationByHandle,
    };
    const FILE_RENAME_FLAG_REPLACE_IF_EXISTS: u32 = 0x1;
    const FILE_RENAME_FLAG_POSIX_SEMANTICS: u32 = 0x2;

    let name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let name_bytes = u32::try_from(name.len() * 2)
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "경로가 너무 깁니다."))?;
    let size = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + (name.len() + 1) * 2;
    let size_u32 = u32::try_from(size)
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "경로가 너무 깁니다."))?;
    let set = |class: FILE_INFO_BY_HANDLE_CLASS, flags: Option<u32>| -> io::Result<()> {
        // FILE_RENAME_INFO는 이름 길이만큼 뒤로 늘어나는 구조체다. u64 버퍼로 정렬을 맞춘다.
        let mut buffer = vec![0u64; size.div_ceil(8).max(1)];
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: buffer는 0으로 채워져 있고 FILE_RENAME_INFO 머리와 이름(끝의 NUL 포함)을 담을 만큼 크며,
        // u64 정렬이므로 HANDLE 필드 정렬도 만족한다. 이름은 FileName 위치부터 name.len()개만 쓴다.
        unsafe {
            match flags {
                Some(flags) => (*info).Anonymous.Flags = flags,
                None => (*info).Anonymous.ReplaceIfExists = true,
            }
            (*info).RootDirectory = std::ptr::null_mut();
            (*info).FileNameLength = name_bytes;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                (&raw mut (*info).FileName).cast::<u16>(),
                name.len(),
            );
            if SetFileInformationByHandle(file.as_raw_handle(), class, info.cast(), size_u32) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    };
    set(
        FileRenameInfoEx,
        Some(FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS),
    )
    .or_else(|_| set(FileRenameInfo, None))
}

#[cfg(unix)]
fn check_staging_parent(parent: &Path) -> AppResult<()> {
    use std::os::unix::fs::MetadataExt;

    // 현재 사용자의 소유권을 확인할 수 있는 임시 파일을 기준으로 삼는다.
    let uid = tempfile::tempfile()?.metadata()?.uid();
    for directory in parent.ancestors() {
        let metadata = directory.metadata()?;
        let reason = if metadata.uid() != uid && metadata.uid() != 0 {
            "다른 사용자 소유"
        } else if metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0 {
            "다른 사용자도 쓰기 가능"
        } else {
            continue;
        };
        return Err(AppError::InvalidInput(format!(
            "'{}' 폴더는 {reason}여서 다른 사용자가 저장 중인 파일을 바꿔치기할 수 있습니다. \
             내 문서 폴더나 USB처럼 나만 쓸 수 있는 폴더를 선택해 주세요.",
            directory.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn lock_path(path: &Path, is_directory: bool) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    use std::os::windows::fs::MetadataExt;

    // 핸들이 살아 있는 동안 이름 변경·삭제를 허용하지 않는다.
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if metadata.is_dir() != is_directory
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "안전한 저장 폴더를 열 수 없습니다.",
        ));
    }
    Ok(file)
}

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

/// 경로가 가리키는 파일의 식별값. 열린 작업 파일이 다른 파일로 바뀌었는지 비교할 때 쓴다.
///
/// 유닉스에서는 파일을 열지 않고 장치·inode 번호만 읽는다. SQLite가 쓰는 POSIX 잠금은 프로세스
/// 단위라서, 같은 파일을 가리키는 다른 fd를 하나라도 닫으면 SQLite 연결이 쥔 트랜잭션 잠금까지 풀린다.
/// Windows의 잠금은 핸들 단위라 핸들을 열어 비교해도 된다.
#[derive(Debug, PartialEq, Eq)]
pub struct FileId(#[cfg(unix)] (u64, u64), #[cfg(windows)] Handle);

impl FileId {
    pub fn of(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(path)?;
            Ok(Self((metadata.dev(), metadata.ino())))
        }
        #[cfg(windows)]
        {
            Ok(Self(Handle::from_path(path)?))
        }
    }
}

/// 저장 대상이 이미 열려 있는 파일과 같은지 확인한다. 대상이 없으면 새 파일로 저장할 수 있다.
/// 핸들을 열었다 닫으므로 SQLite 트랜잭션이 열려 있는 동안에는 부르지 않는다(`FileId` 참고).
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

    #[cfg(unix)]
    #[test]
    fn staging_rejects_shared_writable_folders_and_names_them() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("공유");
        fs::create_dir(&shared).unwrap();
        let set_mode = |mode| fs::set_permissions(&shared, fs::Permissions::from_mode(mode));

        set_mode(0o775).unwrap();
        let Err(AppError::InvalidInput(message)) = StagedFile::new(&shared.join("a.mix")) else {
            panic!("그룹 쓰기 폴더는 거부해야 합니다.");
        };
        assert!(
            message.contains("공유") && message.contains("쓰기 가능"),
            "{message}"
        );
        // 하위 폴더를 골라도 상위 폴더 때문에 거부된다.
        set_mode(0o777).unwrap();
        fs::create_dir(shared.join("내 폴더")).unwrap();
        assert!(StagedFile::new(&shared.join("내 폴더/a.mix")).is_err());
        // sticky 비트가 있으면 다른 사용자가 내 항목의 이름을 바꿀 수 없다.
        set_mode(0o1777).unwrap();
        assert!(StagedFile::new(&shared.join("a.mix")).is_ok());
        set_mode(0o755).unwrap();
        assert!(StagedFile::new(&shared.join("a.mix")).is_ok());
    }

    #[test]
    fn work_files_on_local_disks_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure_local_volume(&dir.path().join("새 작업.mix")).is_ok());
        // 폴더가 없으면 판별할 수 없으므로 오류다.
        assert!(ensure_local_volume(&dir.path().join("없는 폴더/a.mix")).is_err());
    }

    /// 다른 프로세스(sqlite3 명령)의 쓰기가 막혀 있는지 본다. 같은 프로세스 안의 연결은
    /// SQLite가 따로 막으므로 POSIX 잠금이 풀렸는지 확인하려면 다른 프로세스가 필요하다.
    #[cfg(unix)]
    fn external_write_blocked(path: &Path) -> Option<bool> {
        let output = std::process::Command::new("sqlite3")
            .arg(path)
            .arg("UPDATE meta SET title = '외부' WHERE id = 1;")
            .output()
            .ok()?;
        Some(!output.status.success())
    }

    #[cfg(unix)]
    #[test]
    fn file_id_keeps_sqlite_locks_but_closing_a_handle_drops_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("잠금.mix");
        let conn = crate::db::create_new(&path, "잠금").unwrap();
        let identity = FileId::of(&path).unwrap();
        conn.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let Some(blocked) = external_write_blocked(&path) else {
            eprintln!("sqlite3 명령이 없어 다른 프로세스 잠금 검사를 건너뜁니다.");
            return;
        };
        assert!(blocked, "배타 잠금 중에는 다른 프로세스가 쓸 수 없다");
        // 파일을 열지 않는 비교는 잠금을 유지한다.
        assert_eq!(FileId::of(&path).unwrap(), identity);
        assert_eq!(external_write_blocked(&path), Some(true));
        // 같은 파일의 다른 fd를 닫으면 잠금이 풀린다(그래서 트랜잭션 중에는 FileId만 쓴다).
        drop(Handle::from_path(&path).unwrap());
        assert_eq!(external_write_blocked(&path), Some(false));
        conn.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn document_read_enforces_the_byte_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.pdf");
        fs::write(&path, b"%PDF").unwrap();
        assert_eq!(read_document(&path, 4, "PDF").unwrap(), b"%PDF");
        assert!(read_document(&path, 3, "PDF").is_err());
    }
}
