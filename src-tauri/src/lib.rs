mod api;
mod config;
mod sessions;
mod skills;
mod tasks;
mod tools;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

/// Returns the dswork data directory: ~/.dswork/
pub(crate) fn dswork_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法获取用户目录".to_string())?;
    let dir = home.join(".dswork");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 .dswork 目录失败: {}", e))?;
    Ok(dir)
}

/// 把 `~` / `~/...`（Windows 上还支持 `~\...`）展开为用户主目录；其余路径原样返回。
pub(crate) fn expand_tilde(path: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    if path == "~" {
        return home;
    }
    if let Some(rest) = path
        .strip_prefix("~/")
        .or_else(|| path.strip_prefix("~\\"))
    {
        if rest.is_empty() {
            return home;
        }
        return home.join(rest);
    }
    PathBuf::from(path)
}

/// Process-wide monotonic counter so ids generated in the same millisecond
/// (e.g. two quick `create_session` calls) never collide.
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Collision-safe id for sessions/messages.
pub(crate) fn generate_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let seq = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{:x}", millis, seq)
}

/// 全局复用 HTTP 客户端：连接池与 TLS 会话跨请求复用（此前每个命令新建 Client，
/// 每次请求都重新建连，无法复用 keep-alive 连接）。
/// 超时不锁死在客户端上，由各调用方用 RequestBuilder::timeout() 按请求设置。
pub(crate) fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// 原子写文本文件：先写同目录 `.tmp` 再 `rename`（同文件系统内 rename 是原子的），
/// 主文件永远不会处于半写状态；Windows 上 rename 不能覆盖已存在文件，先删旧再改名。
pub(crate) fn atomic_write_text(path: &Path, data: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无效文件路径".to_string())?;
    let tmp = path.with_file_name(format!("{}.tmp", file_name));
    std::fs::write(&tmp, data).map_err(|e| format!("写入临时文件失败: {}", e))?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = std::fs::remove_file(path);
            std::fs::rename(&tmp, path).map_err(|e| format!("替换文件失败: {}", e))
        }
    }
}

/// 测试专用：串行化所有 set_var(HOME) 的测试（HOME 是进程全局环境变量，
/// sessions/tasks 的 with_temp_home 并行运行时互相污染）。
#[cfg(test)]
pub(crate) static TEST_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            tools::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::clear_deepseek_api_key,
            config::get_deepseek_config,
            config::save_deepseek_config,
            api::send_deepseek_chat,
            api::summarize_messages,
            api::test_deepseek_connection,
            skills::list_skills,
            skills::get_skill,
            tools::execute_tool,
            tools::answer_user,
            sessions::create_session,
            sessions::delete_session,
            sessions::rename_session,
            sessions::get_session,
            sessions::update_session_cwd,
            sessions::save_session_messages,
            sessions::save_session_active_skills,
            sessions::auto_title_session,
            sessions::list_all_sessions,
            tasks::create_task,
            tasks::list_tasks,
            tasks::get_task,
            tasks::delete_task,
            tasks::cancel_task,
            tasks::update_task,
            tasks::generate_task_title,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
