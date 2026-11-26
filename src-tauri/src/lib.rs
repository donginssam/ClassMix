mod board;
mod changes;
mod commands;
mod crypto;
mod db;
mod error;
mod export;
mod names;
mod os_integration;
mod paths;
mod roster;
mod settings;
#[cfg(test)]
mod test_support;
mod xlsx_import;

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, RunEvent};

use commands::AppState;

/// 화면에 "열 파일이 있다"고 알리는 이벤트. 경로는 `take_launch_file`로 가져간다.
const OPEN_FILE_EVENT: &str = "open-file-requested";

/// `.mix` 경로를 맡겨 두고 화면에 알린다. 창도 앞으로 가져온다.
fn request_open(app: &AppHandle, path: PathBuf) {
    app.state::<AppState>().request_open(path);
    let _ = app.emit(OPEN_FILE_EVENT, ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// macOS 기본 메뉴의 [실행 취소]는 Cmd+Z를 가로채 웹뷰 자체 되돌리기로 보내므로,
/// 직접 만든 메뉴 항목으로 바꿔 화면에 `menu-undo`/`menu-redo` 이벤트를 보낸다.
/// (Windows는 메뉴가 없어 화면의 Ctrl+Z/Y 키 처리로 동작한다.)
#[cfg(target_os = "macos")]
fn install_macos_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let undo = MenuItemBuilder::with_id("undo", "실행 취소")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::with_id("redo", "실행 복귀")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "ClassMix")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "편집")
        .item(&undo)
        .item(&redo)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, "윈도우")
        .minimize()
        .maximize()
        .fullscreen()
        .separator()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|handle, event| {
        let name = match event.id().as_ref() {
            "undo" => "menu-undo",
            "redo" => "menu-redo",
            _ => return,
        };
        let _ = handle.emit(name, ());
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Windows: 창을 만들기 전에 WebView2 런타임을 확인한다(없으면 안내 후 종료).
    #[cfg(windows)]
    os_integration::check_webview2_or_exit();

    let state = AppState::default();
    // 탐색기에서 .mix를 더블클릭해 실행된 경우(Windows): 실행 인자로 경로가 온다.
    if let Ok(cwd) = std::env::current_dir()
        && let Some(path) = os_integration::mix_path_from_args(std::env::args(), &cwd)
    {
        state.request_open(path);
    }

    let app = tauri::Builder::default()
        // single-instance는 가장 먼저 등록해야 한다. 이미 실행 중이면 두 번째 실행의 인자를 기존 창으로 보낸다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            match os_integration::mix_path_from_args(argv, std::path::Path::new(&cwd)) {
                Some(path) => request_open(app, path),
                None => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            install_macos_menu(_app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_work_file,
            commands::open_work_file,
            commands::close_work_file,
            commands::get_workspace_snapshot,
            commands::save_work_file_as,
            commands::save_work_file_copy,
            commands::list_recent_files,
            commands::remove_recent_file,
            commands::import_xlsx,
            commands::read_pdf_file,
            commands::apply_pdf_mapping,
            commands::apply_change,
            commands::undo_change,
            commands::redo_change,
            commands::set_memo,
            commands::create_rule,
            commands::update_rule,
            commands::delete_rule,
            commands::resolve_twin_candidates,
            commands::export_xlsx,
            commands::unlock_work_file,
            commands::enable_encryption,
            commands::disable_encryption,
            commands::change_password,
            commands::take_launch_file,
            commands::file_association_status,
            commands::register_file_association,
            commands::unregister_file_association,
            commands::dev_sample_paths,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| match event {
        // 앱을 끌 때 열림 표시를 지운다.
        RunEvent::Exit => handle.state::<AppState>().close(),
        // macOS: Finder에서 .mix를 열면(앱 실행 중이든 아니든) 이 이벤트로 경로가 온다.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            if let Some(path) = urls.iter().filter_map(|u| u.to_file_path().ok()).find(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case(db::FILE_EXTENSION))
            }) {
                request_open(handle, path);
            }
        }
        _ => {}
    });
}
