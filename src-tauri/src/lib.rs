mod board;
mod changes;
mod commands;
mod db;
mod error;
mod export;
mod names;
mod roster;
mod settings;
mod xlsx_import;

use tauri::{Manager, RunEvent};

use commands::AppState;

/// macOS 기본 메뉴의 [실행 취소]는 Cmd+Z를 가로채 웹뷰 자체 되돌리기로 보내므로,
/// 직접 만든 메뉴 항목으로 바꿔 화면에 `menu-undo`/`menu-redo` 이벤트를 보낸다.
/// (Windows는 메뉴가 없어 화면의 Ctrl+Z/Y 키 처리로 동작한다.)
#[cfg(target_os = "macos")]
fn install_macos_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Emitter;
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            install_macos_menu(_app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_work_file,
            commands::open_work_file,
            commands::close_work_file,
            commands::get_workspace,
            commands::save_work_file_as,
            commands::save_work_file_copy,
            commands::list_recent_files,
            commands::remove_recent_file,
            commands::import_xlsx,
            commands::list_students,
            commands::list_gaps,
            commands::read_pdf_file,
            commands::apply_pdf_mapping,
            commands::get_board,
            commands::apply_change,
            commands::undo_change,
            commands::redo_change,
            commands::set_memo,
            commands::create_rule,
            commands::update_rule,
            commands::delete_rule,
            commands::resolve_twin_candidates,
            commands::export_xlsx,
            commands::dev_sample_paths,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // 앱을 끌 때 열림 표시를 지운다.
            handle.state::<AppState>().close();
        }
    });
}
