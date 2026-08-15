use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::api::ChatMessage;

/// 落盘串行化（内存锁之外）。`save_session_messages` 与 `auto_title_session`
/// 可以并发（后者是 fire-and-forget），写盘必须串行。
static SESSIONS_LOCK: Mutex<()> = Mutex::new(());

/// 内存权威副本：所有命令读写内存，磁盘只做持久化快照。
/// sessions 有两个写者（保存消息 + 自动命名），以内存为准，
/// 避免「每命令读改写整个文件」导致循环执行中读到旧数据或反复全量解析。
static SESSIONS_STATE: OnceLock<Mutex<StoredSessions>> = OnceLock::new();

/// 自动命名(临时标题 + LLM 生成)的截断长度,与标题生成 prompt 的「不超过20字」一致。
const MAX_AUTO_TITLE_CHARS: usize = 20;
/// 手动重命名的截断长度,与前端输入框 maxLength(30)保持一致。
const MAX_RENAME_CHARS: usize = 30;

/// 去掉首尾空白并截断到 `max_chars` 字符,超长时补省略号。
fn truncate_title(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.trim().chars().collect();
    if chars.len() > max_chars {
        let mut t: String = chars[..max_chars].iter().collect();
        t.push_str("...");
        t
    } else {
        chars.into_iter().collect()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StoredSession {
    id: String,
    title: String,
    created_at: u64,
    updated_at: u64,
    #[serde(default)]
    titled: bool,
    messages: Vec<ChatMessage>,
    /// 会话已激活的 skill 名（持久化）：切换会话 / 重启后恢复，保证 system 前缀
    /// 不因内存态丢失而静默回退（回退 = 一次全量缓存 miss）。
    #[serde(default)]
    active_skills: Vec<String>,
    /// 会话工作目录（持久化）：工具执行与相对路径解析的基准；旧数据缺省为空串，
    /// 迁移时统一填主目录（空串 = 未设置，见 ensure_cwd）。
    #[serde(default)]
    cwd: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    id: String,
    title: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    id: String,
    title: String,
    created_at: u64,
    updated_at: u64,
    messages: Vec<ChatMessage>,
    /// 会话已激活的 skill 名（持久化），前端据此在切换/重启后恢复 system 前缀。
    #[serde(default)]
    active_skills: Vec<String>,
    /// 会话工作目录（绝对路径）：工具执行与相对路径解析的基准。
    cwd: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StoredSessions {
    #[serde(default)]
    titled_migrated: bool,
    sessions: Vec<StoredSession>,
}

fn sessions_path() -> Result<PathBuf, String> {
    let dir = crate::dswork_dir()?;
    Ok(dir.join("sessions.json"))
}

/// 从磁盘读取（仅首次加载 / 测试用）。损坏文件会先被隔离（改名保留现场），
/// 从空状态继续——不让单个文件损坏拖垮整个应用。
fn load_from_disk() -> Result<StoredSessions, String> {
    let path = sessions_path()?;
    if !path.exists() {
        return Ok(StoredSessions {
            titled_migrated: false,
            sessions: Vec::new(),
        });
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match serde_json::from_str::<StoredSessions>(&data) {
        Ok(stored) => Ok(stored),
        Err(e) => {
            let backup = path.with_file_name(format!("sessions.json.corrupt-{}", now_secs()));
            let _ = fs::rename(&path, &backup);
            eprintln!(
                "[sessions] 会话文件损坏，已隔离到 {}（{}），从空会话继续",
                backup.display(),
                e
            );
            Ok(StoredSessions {
                titled_migrated: false,
                sessions: Vec::new(),
            })
        }
    }
}

/// 首次访问时从磁盘加载并执行一次性迁移；之后所有命令读写内存副本。
fn state() -> &'static Mutex<StoredSessions> {
    SESSIONS_STATE.get_or_init(|| {
        let mut stored = match load_from_disk() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[sessions] 加载会话数据失败: {}", e);
                StoredSessions {
                    titled_migrated: false,
                    sessions: Vec::new(),
                }
            }
        };
        let mut changed = ensure_message_ids(&mut stored);
        if ensure_cwd(&mut stored) {
            changed = true;
        }
        if !stored.titled_migrated {
            // 旧数据:已有标题的视为「命名完成」,防止被自动命名覆盖
            for session in &mut stored.sessions {
                if session.title != "新对话" {
                    session.titled = true;
                }
            }
            stored.titled_migrated = true;
            changed = true;
        }
        if changed {
            // 直接写盘，避免经过 persist()（get_or_init 未完成，不可重入 state()）
            if let Err(e) = persist_stored(&stored) {
                eprintln!("[sessions] 迁移后写盘失败: {}", e);
            }
        }
        Mutex::new(stored)
    })
}

fn ensure_message_ids(stored: &mut StoredSessions) -> bool {
    let mut changed = false;
    for session in &mut stored.sessions {
        for message in &mut session.messages {
            if message.id.is_empty() {
                message.id = format!("message_{}", crate::generate_id());
                changed = true;
            }
        }
    }
    changed
}

/// 工作目录迁移：旧数据没有 cwd 字段（反序列化为空串），统一填主目录。
/// 空串 = 未设置（update_session_cwd 校验层不允许保存空路径），幂等可重入。
fn ensure_cwd(stored: &mut StoredSessions) -> bool {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();
    if home.is_empty() {
        return false;
    }
    let mut changed = false;
    for session in &mut stored.sessions {
        if session.cwd.is_empty() {
            session.cwd = home.clone();
            changed = true;
        }
    }
    changed
}

/// 原子落盘：先写临时文件再 rename，主文件不会处于半写状态。
fn persist_stored(stored: &StoredSessions) -> Result<(), String> {
    let path = sessions_path()?;
    let data = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    crate::atomic_write_text(&path, &data)
}

/// 两阶段：内存锁内取快照 → 持 SESSIONS_LOCK 落盘（不持内存锁做磁盘 IO）。
fn persist() -> Result<(), String> {
    let snapshot = state().lock().unwrap().clone();
    let _guard = SESSIONS_LOCK.lock().unwrap();
    persist_stored(&snapshot)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// 从消息里挑一条「像请求」的用户消息做临时标题:跳过过短、过长以及纯确认语。
fn extract_title(messages: &[ChatMessage]) -> Option<String> {
    let confirmations = [
        "好的", "嗯", "好", "可以", "继续", "是的", "行", "ok", "知道了", "收到",
    ];
    for msg in messages {
        if msg.role != "user" {
            continue;
        }
        let Some(trimmed) = msg.content.as_deref().map(str::trim) else {
            continue;
        };
        let len = trimmed.chars().count();
        // 太短(<4字)或过长(>200字,多半是贴了大段内容)的都不适合当标题
        if len < 4 || len > 200 {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if confirmations.contains(&lower.as_str()) {
            continue;
        }
        return Some(truncate_title(trimmed, MAX_AUTO_TITLE_CHARS));
    }
    None
}

fn to_summary(s: &StoredSession) -> SessionSummary {
    SessionSummary {
        id: s.id.clone(),
        title: s.title.clone(),
        created_at: s.created_at,
        updated_at: s.updated_at,
    }
}

fn to_session(s: &StoredSession) -> Session {
    Session {
        id: s.id.clone(),
        title: s.title.clone(),
        created_at: s.created_at,
        updated_at: s.updated_at,
        messages: s.messages.clone(),
        active_skills: s.active_skills.clone(),
        cwd: s.cwd.clone(),
    }
}

#[tauri::command]
pub fn list_all_sessions() -> Result<Vec<SessionSummary>, String> {
    let guard = state().lock().unwrap();
    let mut sorted = guard.sessions.clone();
    sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sorted.into_iter().map(|s| to_summary(&s)).collect())
}

#[tauri::command]
pub fn create_session() -> Result<Session, String> {
    let now = now_secs();
    let cwd = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取用户目录".to_string())?;
    let session = StoredSession {
        id: crate::generate_id(),
        title: "新对话".into(),
        created_at: now,
        updated_at: now,
        titled: false,
        messages: Vec::new(),
        active_skills: Vec::new(),
        cwd,
    };
    state().lock().unwrap().sessions.push(session.clone());
    persist()?;
    Ok(to_session(&session))
}

#[tauri::command]
pub fn delete_session(id: String) -> Result<(), String> {
    state().lock().unwrap().sessions.retain(|s| s.id != id);
    persist()
}

#[tauri::command]
pub fn rename_session(id: String, name: String) -> Result<(), String> {
    let title = truncate_title(&name, MAX_RENAME_CHARS);
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    {
        let mut guard = state().lock().unwrap();
        let session = guard
            .sessions
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("会话 {} 不存在", id))?;
        session.title = title;
        session.titled = true;
        session.updated_at = now_secs();
    }
    persist()
}

#[tauri::command]
pub fn get_session(id: String) -> Result<Session, String> {
    let guard = state().lock().unwrap();
    let session = guard
        .sessions
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("会话 {} 不存在", id))?;
    Ok(to_session(session))
}

/// 查询会话的工作目录（供 tasks::create_task 继承；会话不存在时返回 None）。
pub(crate) fn get_session_cwd(id: &str) -> Option<String> {
    let guard = state().lock().unwrap();
    guard
        .sessions
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.cwd.clone())
}

/// 更新会话工作目录：支持 `~` / `~/...` 展开；目录必须存在且为目录，否则报错。
/// 不更新 updated_at——cwd 变更属于会话元数据，不应打乱侧栏按活动时间排序。
#[tauri::command]
pub fn update_session_cwd(id: String, cwd: String) -> Result<(), String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Err("工作目录不能为空".to_string());
    }
    let expanded = crate::expand_tilde(cwd);
    if !expanded.exists() {
        return Err(format!("目录不存在: {}", expanded.display()));
    }
    if !expanded.is_dir() {
        return Err(format!("不是有效的目录: {}", expanded.display()));
    }
    let canonical = expanded
        .canonicalize()
        .map_err(|e| format!("解析目录失败: {}", e))?;
    {
        let mut guard = state().lock().unwrap();
        let session = guard
            .sessions
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("会话 {} 不存在", id))?;
        session.cwd = canonical.to_string_lossy().to_string();
    }
    persist()
}

#[tauri::command]
pub fn save_session_messages(
    id: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    {
        let mut guard = state().lock().unwrap();
        let session = guard
            .sessions
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("会话 {} 不存在", id))?;

        session.messages = messages;
        session.updated_at = now_secs();

        // Provisional title from the first suitable user message (fast, no network);
        // the real title is generated later by auto_title_session once a reply lands.
        if !session.titled {
            if let Some(title) = extract_title(&session.messages) {
                session.title = title;
            }
        }
    }
    persist()
}

#[tauri::command]
pub fn save_session_active_skills(id: String, active_skills: Vec<String>) -> Result<(), String> {
    {
        let mut guard = state().lock().unwrap();
        let session = guard
            .sessions
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("会话 {} 不存在", id))?;
        session.active_skills = active_skills;
    }
    persist()
}

#[tauri::command]
pub async fn auto_title_session(id: String) -> Result<(), String> {
    // Phase 1: compute the title (may hit the network) WITHOUT holding the
    // lock, so concurrent message saves are never blocked or raced.
    let (titled, has_assistant_reply, title_msgs) = {
        let guard = state().lock().unwrap();
        let session = guard
            .sessions
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("会话 {} 不存在", id))?;
        let has_assistant_reply = session.messages.iter().any(|m| {
            m.role == "assistant" && m.content.as_deref().map_or(false, |c| !c.is_empty())
        });
        let title_msgs: Vec<ChatMessage> = session
            .messages
            .iter()
            .filter(|m| m.role == "user" || (m.role == "assistant" && m.content.is_some()))
            .take(4)
            .cloned()
            .collect();
        (session.titled, has_assistant_reply, title_msgs)
    };

    if titled || !has_assistant_reply || title_msgs.is_empty() {
        return Ok(());
    }

    // 标题生成是一次网络请求,失败不影响会话本身,只记录日志便于排查。
    let generated = match crate::api::generate_title(title_msgs).await {
        Ok(t) => {
            eprintln!("[auto_title] 会话 {} 标题生成成功: {}", id, t);
            Some(t)
        }
        Err(e) => {
            eprintln!("[auto_title] 会话 {} 标题生成失败: {}", id, e);
            None
        }
    };

    // Phase 2: apply the title under the lock, re-reading fresh state so we
    // never clobber messages persisted concurrently.
    if let Some(title) = generated {
        // 模型可能不遵守「不超过20字」的约束,代码里兜底截断。
        let title = truncate_title(&title, MAX_AUTO_TITLE_CHARS);
        let need_persist = {
            let mut guard = state().lock().unwrap();
            let session = guard
                .sessions
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or_else(|| format!("会话 {} 不存在", id))?;
            if !session.titled {
                session.title = title;
                session.titled = true;
                session.updated_at = now_secs();
                true
            } else {
                false
            }
        };
        if need_persist {
            persist()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用临时 HOME 隔离 ~/.dswork，避免污染真实目录。
    /// 持进程级 TEST_HOME_LOCK：HOME 是全局环境变量，与 tasks 测试并行 set_var 会互相污染。
    fn with_temp_home(f: impl FnOnce()) {
        let _guard = crate::TEST_HOME_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "dswork-sessions-test-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        f();
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn user_msg(content: &str) -> ChatMessage {
        ChatMessage {
            id: String::new(),
            role: "user".into(),
            content: Some(content.into()),
            reasoning: None,
            context: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            usage: None,
        }
    }

    #[test]
    fn storage_smoke_and_corruption_recovery() {
        with_temp_home(|| {
            // 创建会话
            let s = create_session().unwrap();
            assert_eq!(s.title, "新对话");
            assert!(s.messages.is_empty());

            // 保存消息 + 临时标题（足够长的用户消息）
            save_session_messages(
                s.id.clone(),
                vec![user_msg("帮我看看这个项目的缓存实现")],
            )
            .unwrap();
            let got = get_session(s.id.clone()).unwrap();
            assert_eq!(got.messages.len(), 1);
            assert_eq!(got.title, "帮我看看这个项目的缓存实现");

            // 列表按 updated_at 倒序：等 1 秒让 s2 的 updated_at 严格更新
            let s2 = create_session().unwrap();
            std::thread::sleep(std::time::Duration::from_secs(1));
            save_session_messages(s2.id.clone(), vec![user_msg("第二个会话")]).unwrap();
            let list = list_all_sessions().unwrap();
            assert_eq!(list.len(), 2);
            assert_eq!(list[0].id, s2.id);
            assert_eq!(list[1].id, s.id);

            // 重命名
            rename_session(s.id.clone(), "缓存体检".into()).unwrap();
            assert_eq!(get_session(s.id.clone()).unwrap().title, "缓存体检");

            // ── 工作目录（cwd）──
            let home = dirs::home_dir().unwrap();
            // 新会话默认工作目录 = 主目录（未解析）
            assert_eq!(s.cwd, home.to_string_lossy().to_string());
            // update 会 canonicalize（macOS 上 /var → /private/var），期望值同样解析
            let home_canon = home.canonicalize().unwrap();
            // `~` 写法 → 展开为主目录
            update_session_cwd(s.id.clone(), "~".into()).unwrap();
            let got = get_session(s.id.clone()).unwrap();
            assert_eq!(got.cwd, home_canon.to_string_lossy().to_string());
            // 子目录 + `~` 展开
            let sub = home.join("subdir");
            std::fs::create_dir_all(&sub).unwrap();
            update_session_cwd(s.id.clone(), "~/subdir".into()).unwrap();
            let got = get_session(s.id.clone()).unwrap();
            assert_eq!(
                got.cwd,
                sub.canonicalize().unwrap().to_string_lossy().to_string()
            );
            // 持久化回环：重新加载磁盘可见
            let stored_disk = load_from_disk().unwrap();
            let stored_s = stored_disk.sessions.iter().find(|x| x.id == s.id).unwrap();
            assert_eq!(
                stored_s.cwd,
                sub.canonicalize().unwrap().to_string_lossy().to_string()
            );
            // 非法路径 / 文件路径被拒绝
            let err = update_session_cwd(s.id.clone(), "~/不存在的目录xyz".into()).unwrap_err();
            assert!(err.contains("目录不存在"), "unexpected: {}", err);
            let f = home.join("afile.txt");
            std::fs::write(&f, "x").unwrap();
            let err = update_session_cwd(s.id.clone(), f.to_str().unwrap().into()).unwrap_err();
            assert!(err.contains("不是有效的目录"), "unexpected: {}", err);
            // 任务继承会话 cwd（get_session_cwd → create_task 回填）
            let task = crate::tasks::create_task("继承 cwd".into(), Some(s.id.clone())).unwrap();
            assert_eq!(
                task.cwd.as_deref(),
                Some(sub.canonicalize().unwrap().to_str().unwrap())
            );
            // 清理：tasks 内存 map 是进程级共享的，不留残留（tasks 测试会断言列表长度）
            crate::tasks::delete_task(task.id.clone()).unwrap();

            // active_skills 持久化：保存 → 读取回环；未设置时默认为空
            assert!(get_session(s.id.clone()).unwrap().active_skills.is_empty());
            save_session_active_skills(s.id.clone(), vec!["code".into(), "explain".into()])
                .unwrap();
            let got = get_session(s.id.clone()).unwrap();
            assert_eq!(got.active_skills, vec!["code", "explain"]);
            save_session_active_skills(s.id.clone(), vec![]).unwrap();
            assert!(get_session(s.id.clone()).unwrap().active_skills.is_empty());

            // 删除
            delete_session(s.id.clone()).unwrap();
            assert!(get_session(s.id.clone()).is_err());

            // 损坏恢复：直接测 load_from_disk（state() 已被缓存，不可重入）
            let path = sessions_path().unwrap();
            fs::write(&path, "{broken json").unwrap();
            let stored = load_from_disk().unwrap();
            assert!(stored.sessions.is_empty());
            // 损坏文件被隔离，不再挡路
            assert!(!path.exists());

            // 原子写：save 后主文件完好、无残留 tmp
            let s3 = create_session().unwrap();
            let _ = s3;
            assert!(path.exists());
            let tmp = path.with_file_name("sessions.json.tmp");
            assert!(!tmp.exists());
        });
    }

    /// 纯函数测试（不依赖 state() 的 OnceLock，可与其它测试并行）。
    #[test]
    fn cwd_legacy_records_migrate_to_home() {
        with_temp_home(|| {
            let home = dirs::home_dir().unwrap();
            // 构造旧数据：cwd 字段缺失（反序列化为空串）
            let mut stored = StoredSessions {
                titled_migrated: false,
                sessions: vec![StoredSession {
                    id: "legacy-1".into(),
                    title: "旧会话".into(),
                    created_at: 1,
                    updated_at: 1,
                    titled: false,
                    messages: Vec::new(),
                    active_skills: Vec::new(),
                    cwd: String::new(),
                }],
            };
            // 空串会被填主目录
            assert!(ensure_cwd(&mut stored));
            assert_eq!(stored.sessions[0].cwd, home.to_string_lossy().to_string());
            // 再次执行无变化（幂等）
            assert!(!ensure_cwd(&mut stored));

            // 真实旧 JSON（无 cwd 字段）反序列化 → 空串 → ensure_cwd 填主目录
            let legacy_json = r#"{"titled_migrated":false,"sessions":[{"id":"legacy-2","title":"旧会话2","created_at":2,"updated_at":2,"titled":false,"messages":[],"active_skills":[]}]}"#;
            let mut parsed: StoredSessions = serde_json::from_str(legacy_json).unwrap();
            assert_eq!(parsed.sessions[0].cwd, "");
            assert!(ensure_cwd(&mut parsed));
            assert_eq!(parsed.sessions[0].cwd, home.to_string_lossy().to_string());
        });
    }
}
