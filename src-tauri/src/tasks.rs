// 任务执行模块后端：仅持久化。
// 执行引擎在前端（共享 runAgentLoop），本模块负责：
//   - 内存权威副本（Mutex<HashMap>），避免「每命令读改写整个文件」导致循环执行中读到旧数据
//   - 落盘节流归前端：前端在步骤边界才调 update_task（幂等全量替换），后端收到即更新内存并写盘
//   - 启动恢复：遗留 running 任务重置为 failed（跨重启续跑本期不做）
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::api::ToolCall;

/// 所有落盘操作（TASKS 内存锁之外）串行化。
static TASKS_LOCK: Mutex<()> = Mutex::new(());
/// 内存权威副本：任务有两个写者（后台循环的 update_task + cancel/delete），
/// 必须以内存为准，get_task 永不读旧文件。
static TASKS: OnceLock<Mutex<HashMap<String, TaskRun>>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    /// 临时标题 + LLM 生成（generate_task_title），步骤边界随 update_task 落盘
    pub title: String,
    /// 任务目标，发给 LLM 的指令
    pub goal: String,
    /// pending | running | done | failed | cancelled
    pub status: String,
    pub steps: Vec<TaskStep>,
    /// 全部步骤完成后的总结性答复（抽屉里展示）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// 任务级错误（如"应用重启导致中断"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 可选：关联的聊天会话
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub id: String,
    pub label: String,
    /// 模型对该步的规划说明
    pub plan: String,
    /// pending | running | done | failed
    pub status: String,
    /// 该步发起的工具调用（参数）
    pub tool_calls: Vec<ToolCall>,
    /// 工具执行结果（前端截断后，展示与持久化用；完整历史由前端循环内存维护）
    pub outputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// list_tasks 的返回项（左侧任务列表用）
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub title: String,
    pub status: String,
    pub step_count: usize,
    pub done_count: usize,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 磁盘结构（含迁移钩子，同 sessions.rs 模式）
#[derive(Debug, Serialize, Deserialize)]
struct StoredTasks {
    #[serde(default)]
    migrated: bool,
    tasks: Vec<TaskRun>,
}

fn tasks_path() -> Result<PathBuf, String> {
    let dir = crate::dswork_dir()?;
    Ok(dir.join("tasks.json"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// 首次访问时从磁盘加载（含启动恢复：running → failed）。
fn state() -> &'static Mutex<HashMap<String, TaskRun>> {
    TASKS.get_or_init(|| {
        let map = match load() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[tasks] 加载任务数据失败: {}", e);
                HashMap::new()
            }
        };
        Mutex::new(map)
    })
}

fn load() -> Result<HashMap<String, TaskRun>, String> {
    let path = tasks_path()?;
    let stored = if path.exists() {
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<StoredTasks>(&data).map_err(|e| e.to_string())?
    } else {
        StoredTasks {
            migrated: false,
            tasks: Vec::new(),
        }
    };

    let mut map = HashMap::new();
    let mut changed = false;
    for mut t in stored.tasks {
        // 启动恢复：遗留 running 任务重置为 failed（真正的跨重启 resume 本期不做）
        if t.status == "running" {
            t.status = "failed".into();
            t.error = Some("应用重启导致中断".into());
            changed = true;
        }
        map.insert(t.id.clone(), t);
    }
    if changed {
        // 直接写盘，避免经过 state()（get_or_init 未完成，不可重入）
        let snapshot: Vec<TaskRun> = map.values().cloned().collect();
        save(&snapshot)?;
    }
    Ok(map)
}

/// 两阶段：无锁计算（内存锁内取快照）→ 持 TASKS_LOCK 落盘。
fn persist() -> Result<(), String> {
    let snapshot: Vec<TaskRun> = {
        let guard = state().lock().unwrap();
        let mut v: Vec<TaskRun> = guard.values().cloned().collect();
        v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        v
    };
    let _guard = TASKS_LOCK.lock().unwrap();
    save(&snapshot)
}

fn save(tasks: &[TaskRun]) -> Result<(), String> {
    let path = tasks_path()?;
    let data = serde_json::to_string_pretty(&StoredTasks {
        migrated: false,
        tasks: tasks.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    crate::atomic_write_text(&path, &data)
}

fn get_task_inner(id: &str) -> Result<TaskRun, String> {
    state()
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("任务 {} 不存在", id))
}

fn to_summary(t: &TaskRun) -> TaskSummary {
    TaskSummary {
        id: t.id.clone(),
        title: t.title.clone(),
        status: t.status.clone(),
        step_count: t.steps.len(),
        done_count: t.steps.iter().filter(|s| s.status == "done").count(),
        created_at: t.created_at,
        updated_at: t.updated_at,
    }
}

#[tauri::command]
pub fn create_task(goal: String, session_id: Option<String>) -> Result<TaskRun, String> {
    let goal = goal.trim().to_string();
    if goal.is_empty() {
        return Err("任务目标不能为空".to_string());
    }
    let now = now_secs();
    let task = TaskRun {
        id: crate::generate_id(),
        title: "新任务".into(),
        goal,
        status: "pending".into(),
        steps: Vec::new(),
        result: None,
        error: None,
        session_id,
        created_at: now,
        updated_at: now,
    };
    state().lock().unwrap().insert(task.id.clone(), task.clone());
    persist()?;
    Ok(task)
}

#[tauri::command]
pub fn list_tasks() -> Result<Vec<TaskSummary>, String> {
    let guard = state().lock().unwrap();
    let mut list: Vec<TaskSummary> = guard.values().map(to_summary).collect();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(list)
}

#[tauri::command]
pub fn get_task(id: String) -> Result<TaskRun, String> {
    get_task_inner(&id)
}

#[tauri::command]
pub fn delete_task(id: String) -> Result<(), String> {
    // 删除前若在运行，前端会先 cancel_task；此处直接删除（后端无法中断前端循环）
    state().lock().unwrap().remove(&id);
    persist()
}

#[tauri::command]
pub fn cancel_task(id: String) -> Result<(), String> {
    {
        let mut guard = state().lock().unwrap();
        let task = guard
            .get_mut(&id)
            .ok_or_else(|| format!("任务 {} 不存在", id))?;
        // 仅运行/待运行可取消；已终态的任务幂等返回
        if task.status == "running" || task.status == "pending" {
            task.status = "cancelled".into();
            task.updated_at = now_secs();
        }
    }
    persist()
}

/// 循环推进时的全量写入（幂等，提交完整 TaskRun）。
#[tauri::command]
pub fn update_task(id: String, task: TaskRun) -> Result<(), String> {
    if task.id != id {
        return Err("任务 id 不匹配".to_string());
    }
    {
        let mut guard = state().lock().unwrap();
        if !guard.contains_key(&id) {
            return Err(format!("任务 {} 不存在", id));
        }
        let mut updated = task;
        // 后端保证 updated_at 为最后活动时间（列表排序正确）
        updated.updated_at = now_secs();
        guard.insert(id.clone(), updated);
    }
    persist()
}

/// 任务命名：复用会话标题生成的 api::generate_title。
#[tauri::command]
pub async fn generate_task_title(goal: String) -> Result<String, String> {
    let messages = vec![crate::api::ChatMessage {
        id: String::new(),
        role: "user".into(),
        content: Some(goal),
        reasoning: None,
        context: None,
        tool_calls: None,
        tool_call_id: None,
        name: None,
        usage: None,
    }];
    crate::api::generate_title(messages).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用临时 HOME 隔离 ~/.dswork，避免污染真实目录。
    fn with_temp_home(f: impl FnOnce()) {
        let dir = std::env::temp_dir().join(format!(
            "dswork-tasks-test-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        f();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn storage_smoke_and_startup_recovery() {
        with_temp_home(|| {
            // create_task：空 steps、pending
            let t = create_task("测试任务".into(), None).unwrap();
            assert_eq!(t.status, "pending");
            assert!(t.steps.is_empty());

            // update_task：幂等全量替换
            let mut t2 = get_task(t.id.clone()).unwrap();
            t2.status = "running".into();
            t2.steps = vec![TaskStep {
                id: "s1".into(),
                label: "步骤1".into(),
                plan: "plan".into(),
                status: "running".into(),
                tool_calls: vec![],
                outputs: vec![],
                error: None,
            }];
            update_task(t.id.clone(), t2.clone()).unwrap();

            let got = get_task(t.id.clone()).unwrap();
            assert_eq!(got.steps.len(), 1);
            assert_eq!(got.steps[0].label, "步骤1");

            // id 不匹配拒绝
            assert!(update_task("other".into(), t2.clone()).is_err());

            // list_tasks 摘要与倒序
            let list = list_tasks().unwrap();
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].step_count, 1);
            assert_eq!(list[0].done_count, 0);

            // cancel_task：running → cancelled；已终态幂等
            cancel_task(t.id.clone()).unwrap();
            assert_eq!(get_task(t.id.clone()).unwrap().status, "cancelled");
            cancel_task(t.id.clone()).unwrap();
            assert_eq!(get_task(t.id.clone()).unwrap().status, "cancelled");

            // delete_task
            delete_task(t.id.clone()).unwrap();
            assert!(list_tasks().unwrap().is_empty());
            assert!(get_task(t.id.clone()).is_err());

            // 启动恢复：磁盘遗留 running → failed + 错误标注
            let running = TaskRun {
                id: "r1".into(),
                title: "x".into(),
                goal: "g".into(),
                status: "running".into(),
                steps: vec![],
                result: None,
                error: None,
                session_id: None,
                created_at: 1,
                updated_at: 1,
            };
            let stored = StoredTasks {
                migrated: false,
                tasks: vec![running],
            };
            let path = tasks_path().unwrap();
            fs::write(&path, serde_json::to_string_pretty(&stored).unwrap()).unwrap();

            // state() 已被 OnceLock 缓存，直接测底层 load()（等价于重启后首次加载）
            let map = load().unwrap();
            let recovered = map.get("r1").unwrap();
            assert_eq!(recovered.status, "failed");
            assert_eq!(recovered.error.as_deref(), Some("应用重启导致中断"));

            // 恢复后已写盘（磁盘上是 failed）
            let on_disk: StoredTasks =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(on_disk.tasks[0].status, "failed");
        });
    }
}
