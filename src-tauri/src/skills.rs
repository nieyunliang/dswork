use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 技能扫描 TTL 缓存：一次对话轮内多次 list/get（每次激活 skill 都会全量扫盘）
/// 复用同一份结果；磁盘上的技能文件编辑在 TTL 后自动生效。
const SKILLS_CACHE_TTL: Duration = Duration::from_secs(2);

struct SkillsCache {
    loaded_at: Instant,
    skills: Vec<Skill>,
}

static SKILLS_CACHE: OnceLock<Mutex<Option<SkillsCache>>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub tools: Option<Vec<String>>,
    pub system_prompt: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub tools: Option<Vec<String>>,
}

/// Skills directory under ~/.dswork/
fn dswork_skills_dir() -> Result<PathBuf, String> {
    let dir = crate::dswork_dir()?.join("skills");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 skills 目录失败: {}", e))?;
    Ok(dir)
}

/// Shared skills directory: ~/.agents/skills/
fn agents_skills_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".agents").join("skills");
    if dir.exists() {
        Some(dir)
    } else {
        None
    }
}

/// Parse YAML frontmatter from SKILL.md content.
/// Handles `name: value`, `description: value`, and `tools: [...]`.
fn parse_frontmatter(frontmatter: &str) -> Result<(String, String, Option<Vec<String>>), String> {
    let mut name = String::new();
    let mut description = String::new();
    let mut tools: Option<Vec<String>> = None;

    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("name:") {
            name = rest.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            description = rest.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(rest) = trimmed.strip_prefix("tools:") {
            let rest = rest.trim();
            if rest == "[]" {
                tools = Some(Vec::new());
            } else if rest.starts_with('[') && rest.ends_with(']') {
                let inner = &rest[1..rest.len() - 1];
                let items: Vec<String> = inner
                    .split(',')
                    .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                tools = Some(items);
            }
        }
    }

    if name.is_empty() {
        return Err("缺少 name 字段".to_string());
    }
    if description.is_empty() {
        return Err("缺少 description 字段".to_string());
    }

    Ok((name, description, tools))
}

/// Parse a SKILL.md file and return a Skill.
fn parse_skill_file(content: &str, dir_name: &str) -> Result<Skill, String> {
    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        return Err(format!("{}/SKILL.md: 无效的 frontmatter 格式", dir_name));
    }

    let frontmatter = parts[1].trim();
    let body = parts[2].trim().to_string();

    let (name, description, tools) = parse_frontmatter(frontmatter)?;

    Ok(Skill {
        name,
        description,
        tools,
        system_prompt: body,
    })
}

/// Scan a directory for skill subdirectories containing SKILL.md.
/// Returns a map of skill name → Skill, with later (override) wins on conflict.
fn scan_skill_dirs(dir: &PathBuf) -> BTreeMap<String, Skill> {
    let mut skills = BTreeMap::new();

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return skills,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }

        let dir_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");

        match fs::read_to_string(&skill_md) {
            Ok(content) => match parse_skill_file(&content, dir_name) {
                Ok(skill) => {
                    skills.insert(skill.name.clone(), skill);
                }
                Err(e) => {
                    eprintln!("解析 skill {} 失败: {}", dir_name, e);
                }
            },
            Err(e) => {
                eprintln!("读取 skill {} 失败: {}", dir_name, e);
            }
        }
    }

    skills
}

/// Load all skills: dswork skills first, then agents shared skills.
/// dswork skills override agents skills with the same name.
fn load_all_skills() -> Vec<Skill> {
    let mut all = BTreeMap::new();

    // 1. Shared skills: ~/.agents/skills/
    if let Some(agents_dir) = agents_skills_dir() {
        for (name, skill) in scan_skill_dirs(&agents_dir) {
            all.insert(name, skill);
        }
    }

    // 2. dswork skills: ~/.dswork/skills/ (overrides shared skills)
    if let Ok(dswork_dir) = dswork_skills_dir() {
        for (name, skill) in scan_skill_dirs(&dswork_dir) {
            all.insert(name, skill);
        }
    }

    all.into_values().collect()
}

/// 带 TTL 缓存的技能加载：TTL 内复用内存副本，过期后重扫磁盘。
fn load_all_skills_cached() -> Vec<Skill> {
    let cell = SKILLS_CACHE.get_or_init(|| Mutex::new(None));
    match cell.lock() {
        Ok(mut guard) => {
            if let Some(cache) = guard.as_ref() {
                if cache.loaded_at.elapsed() < SKILLS_CACHE_TTL {
                    return cache.skills.clone();
                }
            }
            let skills = load_all_skills();
            *guard = Some(SkillsCache {
                loaded_at: Instant::now(),
                skills: skills.clone(),
            });
            skills
        }
        // 锁中毒时退化为直接扫描，不阻塞调用方
        Err(_) => load_all_skills(),
    }
}

// --- Built-in skills (embedded at compile time) ---

const BUILT_IN_SKILLS: &[(&str, &str)] = &[
    ("code", include_str!("../assets/skills/code/SKILL.md")),
    ("explain", include_str!("../assets/skills/explain/SKILL.md")),
    ("research", include_str!("../assets/skills/research/SKILL.md")),
    ("debug", include_str!("../assets/skills/debug/SKILL.md")),
];

/// Write built-in skill directories to ~/.dswork/skills/ if not already present.
fn init_builtin_skills() {
    let dir = match dswork_skills_dir() {
        Ok(d) => d,
        Err(_) => return,
    };

    for (name, content) in BUILT_IN_SKILLS {
        let skill_dir = dir.join(name);
        let skill_file = skill_dir.join("SKILL.md");
        if !skill_file.exists() {
            let _ = fs::create_dir_all(&skill_dir);
            let _ = fs::write(&skill_file, content);
        }
    }
}

// --- IPC Commands ---

#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillSummary>, String> {
    init_builtin_skills();
    let skills = load_all_skills_cached();
    Ok(skills
        .into_iter()
        .map(|s| SkillSummary {
            name: s.name,
            description: s.description,
            tools: s.tools,
        })
        .collect())
}

#[tauri::command]
pub fn get_skill(name: String) -> Result<Skill, String> {
    init_builtin_skills();
    let skills = load_all_skills_cached();
    skills
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("未找到 skill: {}", name))
}
