use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub(crate) struct StoredConfig {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub status: String,
    pub last_tested_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekConfigResponse {
    base_url: String,
    model: String,
    has_api_key: bool,
    status: String,
    last_tested_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConfigInput {
    base_url: String,
    model: String,
    api_key: Option<String>,
    status: String,
    last_tested_at: Option<String>,
}

impl Default for StoredConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-v4-flash".into(),
            api_key: String::new(),
            status: "missing".into(),
            last_tested_at: None,
        }
    }
}

fn config_path() -> Result<PathBuf, String> {
    let dir = crate::dswork_dir()?;
    Ok(dir.join("config.json"))
}

pub(crate) fn load_config() -> Result<StoredConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(StoredConfig::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn save_config_inner(config: &StoredConfig) -> Result<(), String> {
    let path = config_path()?;
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::atomic_write_text(&path, &data)
}

#[tauri::command]
pub fn get_deepseek_config() -> DeepSeekConfigResponse {
    match load_config() {
        Ok(c) => DeepSeekConfigResponse {
            base_url: c.base_url,
            model: c.model,
            has_api_key: !c.api_key.is_empty(),
            status: c.status,
            last_tested_at: c.last_tested_at,
        },
        Err(_) => DeepSeekConfigResponse {
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-v4-flash".into(),
            has_api_key: false,
            status: "missing".into(),
            last_tested_at: None,
        },
    }
}

#[tauri::command]
pub fn save_deepseek_config(
    input: SaveConfigInput,
) -> Result<(), String> {
    let previous = load_config().unwrap_or_default();
    let config = StoredConfig {
        base_url: input.base_url,
        model: input.model,
        api_key: input.api_key.unwrap_or(previous.api_key),
        status: input.status,
        last_tested_at: input.last_tested_at,
    };
    save_config_inner(&config)
}

#[tauri::command]
pub fn clear_deepseek_api_key() -> Result<(), String> {
    let mut config = load_config().unwrap_or_default();
    config.api_key = String::new();
    config.status = "missing".into();
    config.last_tested_at = None;
    save_config_inner(&config)
}
