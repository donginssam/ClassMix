//! 앱 설정(최근 파일 목록). 학생 데이터는 넣지 않는다.
//!
//! Windows(포터블): 실행 파일 옆 `ClassMix.settings.json`. 그 폴더에 쓸 수 없으면 앱 설정 폴더(`%APPDATA%\dev.donginssam.classmix`).
//! macOS: 앱 설정 폴더(`~/Library/Application Support/dev.donginssam.classmix`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::AppResult;

const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub recent_files: Vec<RecentEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub opened_at: String,
    pub exists: bool,
}

#[cfg(windows)]
fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(".classmix_write_test");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn settings_path(app: &AppHandle) -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(exe) = std::env::current_exe()
            && let Some(dir) = exe.parent()
            && dir_is_writable(dir)
        {
            return dir.join("ClassMix.settings.json");
        }
    }
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("ClassMix"));
    dir.join("settings.json")
}

pub fn load_from(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_to(path: &Path, settings: &Settings) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    // 임시 파일에 다 쓴 뒤 바꿔 넣는다: 쓰다가 멈춰도 기존 설정 파일이 깨지지 않는다.
    let tmp = crate::db::temp_path_for(path);
    std::fs::write(&tmp, json).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    crate::db::replace_with(&tmp, path)
}

pub fn push_recent(settings: &mut Settings, path: &Path) {
    let p = path.to_string_lossy().to_string();
    settings.recent_files.retain(|e| e.path != p);
    settings.recent_files.insert(
        0,
        RecentEntry {
            path: p,
            opened_at: crate::db::now(),
        },
    );
    settings.recent_files.truncate(MAX_RECENT);
}

pub fn remove_recent(settings: &mut Settings, path: &str) {
    settings.recent_files.retain(|e| e.path != path);
}

pub fn recent_files(settings: &Settings) -> Vec<RecentFile> {
    settings
        .recent_files
        .iter()
        .map(|e| {
            let p = Path::new(&e.path);
            RecentFile {
                path: e.path.clone(),
                name: p
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                opened_at: e.opened_at.clone(),
                exists: p.is_file(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_list_is_deduplicated_and_capped() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        for i in 0..12 {
            push_recent(&mut s, &dir.path().join(format!("{i}.mix")));
        }
        push_recent(&mut s, &dir.path().join("5.mix"));
        assert_eq!(s.recent_files.len(), MAX_RECENT);
        assert!(s.recent_files[0].path.ends_with("5.mix"));
        assert_eq!(
            s.recent_files
                .iter()
                .filter(|e| e.path.ends_with("5.mix"))
                .count(),
            1
        );

        let path = dir.path().join("settings.json");
        save_to(&path, &s).unwrap();
        assert_eq!(load_from(&path).recent_files.len(), MAX_RECENT);
        assert!(
            load_from(&dir.path().join("missing.json"))
                .recent_files
                .is_empty()
        );
    }

    #[test]
    fn save_replaces_the_settings_file_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ClassMix.settings.json");
        std::fs::write(&p, "{ 깨진 이전 파일").unwrap();
        let mut s = Settings::default();
        push_recent(&mut s, Path::new("/a/b.mix"));
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p).recent_files.len(), 1);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1);
    }
}
