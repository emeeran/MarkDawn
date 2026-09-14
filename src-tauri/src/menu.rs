use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Typora-style application menu. Every item emits `menu-action` with its id
/// to the webview, where the command registry handles it. Accelerators live
/// here (native) — the frontend has no duplicate keybindings.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let file = file_menu(app)?;
    let edit = edit_menu(app)?;
    let paragraph = paragraph_menu(app)?;
    let format = format_menu(app)?;
    let view = view_menu(app)?;
    let themes = themes_menu(app)?;
    let help = help_menu(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &paragraph, &format, &view, &themes, &help])
        .build()?;

    if let Some(window) = app.get_webview_window("main") {
        window.set_menu(menu)?;
        let handle = app.clone();
        window.on_menu_event(move |_window, event| {
            let _ = handle.emit("menu-action", event.id().0.to_string());
        });
    }
    Ok(())
}

fn sep(app: &AppHandle) -> tauri::Result<PredefinedMenuItem<Wry>> {
    PredefinedMenuItem::separator(app)
}

fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, true, accel)
}

fn file_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let m = Submenu::new(app, "File", true)?;
    let export = export_menu(app)?;
    m.append_items(&[
        &item(app, "file.new", "New File", Some("CmdOrCtrl+N"))?,
        &item(app, "file.open", "Open…", Some("CmdOrCtrl+O"))?,
        &item(app, "file.openFolder", "Open Folder…", Some("Shift+CmdOrCtrl+O"))?,
        &sep(app)?,
        &item(app, "file.save", "Save", Some("CmdOrCtrl+S"))?,
        &item(app, "file.saveAs", "Save As…", Some("Shift+CmdOrCtrl+S"))?,
        &sep(app)?,
        &export,
        &sep(app)?,
        &item(app, "app.settings", "Preferences…", Some("CmdOrCtrl+,"))?,
        &sep(app)?,
        &item(app, "file.closeTab", "Close Tab", Some("CmdOrCtrl+W"))?,
        &PredefinedMenuItem::quit(app, None)?,
    ])?;
    Ok(m)
}

fn export_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let m = Submenu::new(app, "Export", true)?;
    m.append_items(&[
        &item(app, "export.html", "HTML…", None)?,
        &item(app, "export.pdf", "PDF…", None)?,
        &sep(app)?,
        &item(app, "export.docx", "Word (.docx)…", None)?,
        &item(app, "export.latex", "LaTeX…", None)?,
        &item(app, "export.rtf", "RTF…", None)?,
        &item(app, "export.epub", "EPUB…", None)?,
    ])?;
    Ok(m)
}

fn edit_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let m = Submenu::new(app, "Edit", true)?;
    m.append_items(&[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &sep(app)?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
        &sep(app)?,
        &item(app, "edit.find", "Find / Replace…", Some("CmdOrCtrl+F"))?,
    ])?;
    Ok(m)
}

fn paragraph_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let m = Submenu::new(app, "Paragraph", true)?;
    m.append_items(&[
        &item(app, "para.h1", "Heading 1", Some("CmdOrCtrl+1"))?,
        &item(app, "para.h2", "Heading 2", Some("CmdOrCtrl+2"))?,
        &item(app, "para.h3", "Heading 3", Some("CmdOrCtrl+3"))?,
        &item(app, "para.h4", "Heading 4", Some("CmdOrCtrl+4"))?,
        &item(app, "para.h5", "Heading 5", Some("CmdOrCtrl+5"))?,
        &item(app, "para.h6", "Heading 6", Some("CmdOrCtrl+6"))?,
        &sep(app)?,
        &item(app, "para.quote", "Blockquote", Some("CmdOrCtrl+Shift+Q"))?,
        &item(app, "para.ul", "Bullet List", Some("CmdOrCtrl+Shift+8"))?,
        &item(app, "para.ol", "Ordered List", Some("CmdOrCtrl+Shift+7"))?,
        &item(app, "para.task", "Task List", Some("CmdOrCtrl+Shift+9"))?,
        &sep(app)?,
        &item(app, "para.code", "Code Block", Some("CmdOrCtrl+Shift+K"))?,
        &item(app, "para.math", "Math Block", Some("CmdOrCtrl+Shift+M"))?,
        &item(app, "para.table", "Table", Some("CmdOrCtrl+Shift+T"))?,
        &item(app, "para.hr", "Horizontal Rule", None)?,
    ])?;
    Ok(m)
}

fn format_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let m = Submenu::new(app, "Format", true)?;
    m.append_items(&[
        &item(app, "fmt.bold", "Bold", Some("CmdOrCtrl+B"))?,
        &item(app, "fmt.italic", "Italic", Some("CmdOrCtrl+I"))?,
        &item(app, "fmt.code", "Inline Code", Some("CmdOrCtrl+Shift+C"))?,
        &item(app, "fmt.strike", "Strikethrough", Some("Alt+Shift+5"))?,
        &sep(app)?,
        &item(app, "fmt.clear", "Clear Formatting", Some("CmdOrCtrl+\\"))?,
    ])?;
    Ok(m)
}

fn view_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let m = Submenu::new(app, "View", true)?;
    m.append_items(&[
        &item(app, "view.source", "Source Mode", Some("CmdOrCtrl+/"))?,
        &item(app, "view.focus", "Focus Mode", Some("CmdOrCtrl+Shift+F"))?,
        &item(app, "view.typewriter", "Typewriter Mode", Some("Alt+CmdOrCtrl+T"))?,
        &sep(app)?,
        &item(app, "view.sidebar", "File Tree", Some("CmdOrCtrl+Shift+L"))?,
        &item(app, "view.outline", "Outline", Some("Alt+CmdOrCtrl+O"))?,
        &item(app, "view.ai", "AI Panel", Some("CmdOrCtrl+Shift+A"))?,
        &sep(app)?,
        &item(app, "view.palette", "Command Palette…", Some("CmdOrCtrl+K"))?,
        &item(app, "view.quickopen", "Quick Open…", Some("CmdOrCtrl+P"))?,
    ])?;
    Ok(m)
}

fn themes_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let m = Submenu::new(app, "Themes", true)?;
    m.append_items(&[
        &item(app, "theme:github", "GitHub", None)?,
        &item(app, "theme:night", "Night", None)?,
        &item(app, "theme:newsprint", "Newsprint", None)?,
        &item(app, "theme:pixyll", "Pixyll", None)?,
    ])?;
    Ok(m)
}

fn help_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let m = Submenu::new(app, "Help", true)?;
    m.append_items(&[&item(app, "help.about", "About Notepad", None)?])?;
    Ok(m)
}
