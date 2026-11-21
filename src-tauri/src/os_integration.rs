//! 운영체제 연동: 실행 인자로 받은 `.mix` 경로, `.mix` 파일 연결 등록·해제(Windows),
//! WebView2 런타임 확인(Windows).
//!
//! Windows는 설치 프로그램이 없는 포터블 exe이므로 파일 연결을 앱 안에서 현재 사용자 레지스트리
//! (`HKCU\Software\Classes`, 관리자 권한 불필요)에 직접 등록한다. macOS는 `.app` 번들 설정
//! (`tauri.conf.json`의 `fileAssociations`)으로 자동 등록되고 `RunEvent::Opened`로 경로가 온다.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::db::FILE_EXTENSION;

/// 레지스트리에 등록하는 ProgID.
#[cfg_attr(not(windows), allow(dead_code))]
pub const PROG_ID: &str = "ClassMix.mix";

/// 실행 인자 중 `.mix` 파일 경로를 찾는다. 상대 경로는 `cwd` 기준으로 바꾼다.
/// (첫 인자는 실행 파일 자신이므로 건너뛴다. macOS의 `-psn_…` 같은 옵션도 무시된다.)
pub fn mix_path_from_args<I, S>(args: I, cwd: &Path) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().skip(1).find_map(|a| {
        let a = a.as_ref().trim().trim_matches('"');
        if a.starts_with('-') {
            return None;
        }
        let p = Path::new(a);
        let is_mix = p
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(FILE_EXTENSION));
        if !is_mix {
            return None;
        }
        Some(if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        })
    })
}

/// 레지스트리 열기 명령(`"C:\…\ClassMix.exe" "%1"`)에서 실행 파일 경로를 꺼낸다.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn exe_from_open_command(command: &str) -> Option<String> {
    let s = command.trim();
    let exe = if let Some(rest) = s.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        s.split_whitespace().next()?
    };
    (!exe.is_empty()).then(|| exe.to_string())
}

/// 경로 두 개가 같은 파일을 가리키는지(Windows는 대소문자 무시).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssociationState {
    /// 이 운영체제에서는 앱 안에서 등록하지 않는다(macOS: 번들이 자동 등록).
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    /// 등록되어 있지 않다.
    None,
    /// 지금 실행 중인 exe로 등록되어 있다.
    Current,
    /// 다른 위치의 exe로 등록되어 있다(exe를 옮겼거나 다른 사본).
    Moved,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationStatus {
    pub state: AssociationState,
    /// 레지스트리에 적힌 실행 파일 경로
    pub registered_exe: Option<String>,
    /// 지금 실행 중인 실행 파일 경로
    pub current_exe: Option<String>,
}

#[cfg(windows)]
pub use windows_impl::{check_webview2_or_exit, file_association_status, register, unregister};

#[cfg(not(windows))]
pub fn file_association_status() -> AssociationStatus {
    AssociationStatus {
        state: AssociationState::Unsupported,
        registered_exe: None,
        current_exe: std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
    }
}

#[cfg(not(windows))]
pub fn register() -> crate::error::AppResult<()> {
    Err(crate::error::AppError::InvalidInput(
        "이 운영체제에서는 앱 설치 시 자동으로 연결됩니다.".into(),
    ))
}

#[cfg(not(windows))]
pub fn unregister() -> crate::error::AppResult<()> {
    register()
}

#[cfg(windows)]
mod windows_impl {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};

    use super::{AssociationState, AssociationStatus, PROG_ID, exe_from_open_command, same_path};
    use crate::db::FILE_EXTENSION;
    use crate::error::{AppError, AppResult};

    const CLASSES: &str = r"Software\Classes";
    const WEBVIEW2_DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";
    /// WebView2 Evergreen 런타임의 EdgeUpdate 클라이언트 GUID.
    const WEBVIEW2_CLIENT: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHChangeNotify(event_id: i32, flags: u32, item1: *const c_void, item2: *const c_void);
        fn ShellExecuteW(
            hwnd: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> *mut c_void;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }

    const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
    const SHCNF_IDLIST: u32 = 0;
    const MB_YESNO: u32 = 0x4;
    const MB_ICONWARNING: u32 = 0x30;
    const IDYES: i32 = 6;
    const SW_SHOWNORMAL: i32 = 1;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn current_exe() -> AppResult<String> {
        Ok(std::env::current_exe()?.to_string_lossy().to_string())
    }

    fn registered_exe() -> Option<String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey_with_flags(format!(r"{CLASSES}\{PROG_ID}\shell\open\command"), KEY_READ)
            .ok()?;
        let cmd: String = key.get_value("").ok()?;
        exe_from_open_command(&cmd)
    }

    pub fn file_association_status() -> AssociationStatus {
        let current = current_exe().ok();
        let registered = registered_exe();
        let state = match (&registered, &current) {
            (None, _) => AssociationState::None,
            (Some(r), Some(c)) if same_path(r, c) => AssociationState::Current,
            _ => AssociationState::Moved,
        };
        AssociationStatus {
            state,
            registered_exe: registered,
            current_exe: current,
        }
    }

    fn notify_shell() {
        // 탐색기에 연결이 바뀌었음을 알려 아이콘·열기 동작을 바로 갱신한다.
        unsafe {
            SHChangeNotify(
                SHCNE_ASSOCCHANGED,
                SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
    }

    fn reg_err(e: std::io::Error) -> AppError {
        AppError::Other(format!("레지스트리에 기록하지 못했습니다: {e}"))
    }

    pub fn register() -> AppResult<()> {
        let exe = current_exe()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        let (ext, _) = hkcu
            .create_subkey(format!(r"{CLASSES}\.{FILE_EXTENSION}"))
            .map_err(reg_err)?;
        ext.set_value("", &PROG_ID).map_err(reg_err)?;
        let (owp, _) = ext.create_subkey("OpenWithProgids").map_err(reg_err)?;
        owp.set_value(PROG_ID, &"").map_err(reg_err)?;

        let (prog, _) = hkcu
            .create_subkey(format!(r"{CLASSES}\{PROG_ID}"))
            .map_err(reg_err)?;
        prog.set_value("", &"ClassMix 반편성 파일")
            .map_err(reg_err)?;
        let (icon, _) = prog.create_subkey("DefaultIcon").map_err(reg_err)?;
        icon.set_value("", &format!("\"{exe}\",0"))
            .map_err(reg_err)?;
        let (cmd, _) = prog.create_subkey(r"shell\open\command").map_err(reg_err)?;
        cmd.set_value("", &format!("\"{exe}\" \"%1\""))
            .map_err(reg_err)?;

        notify_shell();
        Ok(())
    }

    pub fn unregister() -> AppResult<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = hkcu
            .open_subkey_with_flags(CLASSES, KEY_READ | KEY_WRITE)
            .map_err(reg_err)?;

        if let Err(e) = classes.delete_subkey_all(PROG_ID)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            return Err(reg_err(e));
        }

        // `.mix` 키는 ClassMix 것일 때만 정리한다(다른 앱이 쓰는 값은 건드리지 않음).
        let ext_name = format!(".{FILE_EXTENSION}");
        if let Ok(ext) = classes.open_subkey_with_flags(&ext_name, KEY_READ | KEY_WRITE) {
            if ext.get_value::<String, _>("").ok().as_deref() == Some(PROG_ID) {
                let _ = ext.delete_value("");
            }
            if let Ok(owp) = ext.open_subkey_with_flags("OpenWithProgids", KEY_READ | KEY_WRITE) {
                let _ = owp.delete_value(PROG_ID);
                if owp.enum_values().next().is_none() {
                    let _ = ext.delete_subkey("OpenWithProgids");
                }
            }
            let empty = ext.enum_keys().next().is_none() && ext.enum_values().next().is_none();
            drop(ext);
            if empty {
                let _ = classes.delete_subkey(&ext_name);
            }
        }

        notify_shell();
        Ok(())
    }

    fn webview2_version_at(root: &RegKey, path: &str) -> Option<String> {
        let key = root.open_subkey_with_flags(path, KEY_READ).ok()?;
        let pv: String = key.get_value("pv").ok()?;
        let pv = pv.trim().to_string();
        (!pv.is_empty() && pv != "0.0.0.0").then_some(pv)
    }

    /// 설치된 WebView2 런타임 버전(없으면 None). Microsoft 안내에 따른 레지스트리 위치를 본다.
    fn webview2_version() -> Option<String> {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let wow = format!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}");
        let native = format!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}");
        webview2_version_at(&hklm, &wow)
            .or_else(|| webview2_version_at(&hklm, &native))
            .or_else(|| webview2_version_at(&hkcu, &native))
    }

    /// 창을 만들기 전에 WebView2 런타임을 확인한다. 없으면 안내 상자를 띄우고 종료한다.
    /// (고정 버전 런타임을 환경 변수로 지정한 경우는 확인하지 않는다.)
    pub fn check_webview2_or_exit() {
        if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some()
            || webview2_version().is_some()
        {
            return;
        }
        let text = wide(
            "ClassMix를 실행하려면 Microsoft Edge WebView2 런타임이 필요합니다.\n\n\
             Windows 11과 업데이트된 Windows 10에는 기본으로 설치되어 있지만, 이 PC에서는 찾지 못했습니다.\n\n\
             지금 설치 페이지를 열까요?\n\
             (페이지에서 'Evergreen Bootstrapper'를 내려받아 설치한 뒤 ClassMix를 다시 실행하세요.)",
        );
        let caption = wide("ClassMix — WebView2 런타임 필요");
        let answer = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                MB_YESNO | MB_ICONWARNING,
            )
        };
        if answer == IDYES {
            let op = wide("open");
            let url = wide(WEBVIEW2_DOWNLOAD_URL);
            unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    op.as_ptr(),
                    url.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    SW_SHOWNORMAL,
                );
            }
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_mix_path_in_args() {
        let cwd = Path::new("work");
        let abs = std::env::temp_dir().join("2026 2학년.mix");
        assert_eq!(
            mix_path_from_args(["app", abs.to_str().unwrap()], cwd),
            Some(abs.clone())
        );
        assert_eq!(
            mix_path_from_args(["app", "-psn_0_123", "a.MIX"], cwd),
            Some(cwd.join("a.MIX"))
        );
        assert_eq!(mix_path_from_args(["app"], cwd), None);
        assert_eq!(mix_path_from_args(["app", "a.xlsx"], cwd), None);
        // 실행 파일 이름이 .mix로 끝나도 첫 인자는 보지 않는다.
        assert_eq!(mix_path_from_args(["x.mix"], cwd), None);
    }

    #[test]
    fn parses_open_command() {
        assert_eq!(
            exe_from_open_command(r#""D:\USB\반편성\ClassMix.exe" "%1""#).as_deref(),
            Some(r"D:\USB\반편성\ClassMix.exe")
        );
        assert_eq!(
            exe_from_open_command(r"C:\a\ClassMix.exe %1").as_deref(),
            Some(r"C:\a\ClassMix.exe")
        );
        assert_eq!(exe_from_open_command("  "), None);
    }

    #[test]
    fn compares_paths_case_insensitively() {
        assert!(same_path(
            r"C:\Tools\ClassMix.exe",
            r"c:\tools\classmix.EXE"
        ));
        assert!(same_path(
            r"\\?\C:\Tools\ClassMix.exe",
            r"C:\Tools\ClassMix.exe"
        ));
        assert!(!same_path(
            r"C:\Tools\ClassMix.exe",
            r"D:\Tools\ClassMix.exe"
        ));
    }
}
