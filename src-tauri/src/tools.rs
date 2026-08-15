use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use image::GenericImageView;
use tauri::Emitter;
use tokio::sync::oneshot;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteToolInput {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteToolResult {
    pub output: String,
    pub is_error: bool,
}

type ToolFn = fn(serde_json::Value) -> Pin<Box<dyn Future<Output = ExecuteToolResult> + Send>>;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static ASK_USER_TX: OnceLock<Mutex<Option<oneshot::Sender<String>>>> = OnceLock::new();

pub fn init(app_handle: &tauri::AppHandle) {
    let _ = APP_HANDLE.set(app_handle.clone());
    ASK_USER_TX.get_or_init(|| Mutex::new(None));
}

fn registry() -> HashMap<&'static str, ToolFn> {
    let mut m: HashMap<&'static str, ToolFn> = HashMap::new();
    m.insert("read_file", |args| Box::pin(read_file(args)));
    m.insert("write_file", |args| Box::pin(write_file(args)));
    m.insert("list_dir", |args| Box::pin(list_dir(args)));
    m.insert("run_shell", |args| Box::pin(run_shell(args)));
    m.insert("http_get", |args| Box::pin(http_get(args)));
    m.insert("web_search", |args| Box::pin(web_search(args)));
    m.insert("web_fetch", |args| Box::pin(web_fetch(args)));
    m.insert("ask_user", |args| Box::pin(ask_user(args)));
    m.insert("file_search", |args| Box::pin(file_search(args)));
    m.insert("grep", |args| Box::pin(grep(args)));
    m.insert("screenshot", |args| Box::pin(screenshot(args)));
    m.insert("read_pdf_or_image", |args| Box::pin(read_pdf_or_image(args)));
    m
}

#[tauri::command]
pub async fn execute_tool(input: ExecuteToolInput) -> ExecuteToolResult {
    let args: serde_json::Value = match serde_json::from_str(&input.arguments) {
        Ok(v) => v,
        Err(e) => {
            return ExecuteToolResult {
                output: format!("参数解析失败: {}", e),
                is_error: true,
            };
        }
    };
    match registry().get(input.name.as_str()) {
        Some(f) => f(args).await,
        None => ExecuteToolResult {
            output: format!("未知工具: {}", input.name),
            is_error: true,
        },
    }
}

#[tauri::command]
pub async fn answer_user(answer: String) -> Result<(), String> {
    let mut guard = ASK_USER_TX
        .get()
        .ok_or("系统未初始化")?
        .lock()
        .map_err(|_| "内部错误".to_string())?;
    match guard.take() {
        Some(tx) => tx.send(answer).map_err(|_| "用户已取消".to_string()),
        None => Err("没有等待中的问题".to_string()),
    }
}

async fn read_file(args: serde_json::Value) -> ExecuteToolResult {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return ExecuteToolResult {
                output: "缺少 path 参数".into(),
                is_error: true,
            };
        }
    };
    match fs::read_to_string(path) {
        Ok(content) => ExecuteToolResult {
            output: content,
            is_error: false,
        },
        Err(e) => ExecuteToolResult {
            output: format!("读取文件失败: {}", e),
            is_error: true,
        },
    }
}

async fn write_file(args: serde_json::Value) -> ExecuteToolResult {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return ExecuteToolResult {
                output: "缺少 path 参数".into(),
                is_error: true,
            };
        }
    };
    let content = match args.get("content").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => {
            return ExecuteToolResult {
                output: "缺少 content 参数".into(),
                is_error: true,
            };
        }
    };
    match fs::write(path, content) {
        Ok(()) => ExecuteToolResult {
            output: "文件写入成功".into(),
            is_error: false,
        },
        Err(e) => ExecuteToolResult {
            output: format!("写入文件失败: {}", e),
            is_error: true,
        },
    }
}

async fn list_dir(args: serde_json::Value) -> ExecuteToolResult {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return ExecuteToolResult {
                output: "缺少 path 参数".into(),
                is_error: true,
            };
        }
    };
    match fs::read_dir(path) {
        Ok(entries) => {
            let names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let suffix = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        "/"
                    } else {
                        ""
                    };
                    format!("{}{}", name, suffix)
                })
                .collect();
            ExecuteToolResult {
                output: if names.is_empty() {
                    "(空目录)".into()
                } else {
                    names.join("\n")
                },
                is_error: false,
            }
        }
        Err(e) => ExecuteToolResult {
            output: format!("列出目录失败: {}", e),
            is_error: true,
        },
    }
}

async fn run_shell(args: serde_json::Value) -> ExecuteToolResult {
    let command_str = match args.get("command").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => {
            return ExecuteToolResult {
                output: "缺少 command 参数".into(),
                is_error: true,
            };
        }
    };
    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "sh"
    };
    let flag = if cfg!(target_os = "windows") {
        "/C"
    } else {
        "-c"
    };
    // tokio::process::Command：异步执行，不阻塞 tokio worker；
    // 任务场景常跑 pnpm test 这类长命令，同步 output() 会卡住整个运行时。
    match tokio::process::Command::new(shell)
        .arg(flag)
        .arg(command_str)
        .output()
        .await
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let mut result = String::new();
            if !stdout.is_empty() {
                result.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&stderr);
            }
            let is_error = !output.status.success();
            ExecuteToolResult {
                output: if result.is_empty() {
                    if is_error {
                        format!("命令退出码: {}", output.status.code().unwrap_or(-1))
                    } else {
                        "(无输出)".into()
                    }
                } else {
                    result
                },
                is_error,
            }
        }
        Err(e) => ExecuteToolResult {
            output: format!("执行命令失败: {}", e),
            is_error: true,
        },
    }
}

async fn http_get(args: serde_json::Value) -> ExecuteToolResult {
    let url = match args.get("url").and_then(|v| v.as_str()) {
        Some(u) => u,
        None => {
            return ExecuteToolResult {
                output: "缺少 url 参数".into(),
                is_error: true,
            };
        }
    };
    let client = crate::http_client();
    match client.get(url).timeout(std::time::Duration::from_secs(30)).send().await {
        Ok(resp) => {
            let status = resp.status();
            match resp.text().await {
                Ok(text) => {
                    let preview: String = text.chars().take(2000).collect();
                    let mut output = format!("HTTP {}", status);
                    if !preview.is_empty() {
                        output.push_str(&format!("\n{}", preview));
                    }
                    if text.len() > 2000 {
                        output.push_str(&format!(
                            "\n... (剩余 {} 字符已截断)",
                            text.len() - 2000
                        ));
                    }
                    ExecuteToolResult {
                        output,
                        is_error: !status.is_success(),
                    }
                }
                Err(e) => ExecuteToolResult {
                    output: format!("读取响应失败: {}", e),
                    is_error: true,
                },
            }
        }
        Err(e) => ExecuteToolResult {
            output: format!("HTTP 请求失败: {}", e),
            is_error: true,
        },
    }
}

// ---- 新工具 ----

async fn web_search(args: serde_json::Value) -> ExecuteToolResult {
    let query = match args.get("query").and_then(|v| v.as_str()) {
        Some(q) => q.trim(),
        None => {
            return ExecuteToolResult {
                output: "缺少 query 参数".into(),
                is_error: true,
            };
        }
    };

    let url = match reqwest::Url::parse_with_params(
        "https://api.duckduckgo.com/",
        &[
            ("q", query),
            ("format", "json"),
            ("skip_disambig", "1"),
            ("no_html", "1"),
        ],
    ) {
        Ok(u) => u,
        Err(e) => {
            return ExecuteToolResult {
                output: format!("URL 构建失败: {}", e),
                is_error: true,
            };
        }
    };

    let client = crate::http_client();

    match client
        .get(url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
    {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(json) => {
                let mut results: Vec<String> = Vec::new();

                if let Some(answer) = json.get("Answer").and_then(|a| a.as_str()) {
                    if !answer.is_empty() {
                        results.push(format!("答案: {}", answer));
                    }
                }

                if let Some(abstract_text) =
                    json.get("AbstractText").and_then(|a| a.as_str())
                {
                    if !abstract_text.is_empty() {
                        results.push(format!("摘要: {}", abstract_text));
                    }
                }

                if let Some(topics) = json.get("RelatedTopics").and_then(|t| t.as_array()) {
                    for topic in topics {
                        if let Some(text) = topic.get("Text").and_then(|t| t.as_str()) {
                            results.push(format!("- {}", text));
                        }
                        if let Some(sub_topics) = topic.get("Topics").and_then(|t| t.as_array()) {
                            for sub in sub_topics {
                                if let Some(text) = sub.get("Text").and_then(|t| t.as_str()) {
                                    results.push(format!("  - {}", text));
                                }
                                if let Some(url_val) = sub.get("FirstURL").and_then(|u| u.as_str()) {
                                    if !url_val.is_empty() {
                                        results.push(format!("    ({})", url_val));
                                    }
                                }
                            }
                        }
                        if let Some(url_val) = topic.get("FirstURL").and_then(|u| u.as_str()) {
                            if !url_val.is_empty() && topic.get("Topics").is_none() {
                                results.push(format!("    ({})", url_val));
                            }
                        }
                    }
                }

                if results.is_empty() {
                    ExecuteToolResult {
                        output: "未找到相关结果".into(),
                        is_error: false,
                    }
                } else {
                    ExecuteToolResult {
                        output: results.join("\n"),
                        is_error: false,
                    }
                }
            }
            Err(e) => ExecuteToolResult {
                output: format!("解析搜索结果失败: {}", e),
                is_error: true,
            },
        },
        Err(e) => ExecuteToolResult {
            output: format!("搜索请求失败: {}", e),
            is_error: true,
        },
    }
}

async fn web_fetch(args: serde_json::Value) -> ExecuteToolResult {
    let url = match args.get("url").and_then(|v| v.as_str()) {
        Some(u) => u,
        None => {
            return ExecuteToolResult {
                output: "缺少 url 参数".into(),
                is_error: true,
            };
        }
    };

    let client = crate::http_client();

    match client
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            match resp.text().await {
                Ok(text) => {
                    let cleaned: String = text.chars().take(50000).collect();
                    let mut output = format!("HTTP {}", status);
                    if !cleaned.is_empty() {
                        output.push('\n');
                        output.push_str(&cleaned);
                    }
                    if text.len() > 50000 {
                        output.push_str(&format!(
                            "\n... (剩余 {} 字符已截断)",
                            text.len() - 50000
                        ));
                    }
                    ExecuteToolResult {
                        output,
                        is_error: !status.is_success(),
                    }
                }
                Err(e) => ExecuteToolResult {
                    output: format!("读取响应失败: {}", e),
                    is_error: true,
                },
            }
        }
        Err(e) => ExecuteToolResult {
            output: format!("请求失败: {}", e),
            is_error: true,
        },
    }
}

async fn ask_user(args: serde_json::Value) -> ExecuteToolResult {
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("请输入你的回答:");

    let (tx, rx) = oneshot::channel();
    {
        let guard = ASK_USER_TX.get().unwrap();
        let mut sender = guard.lock().unwrap();
        *sender = Some(tx);
    }

    let _ = APP_HANDLE.get().unwrap().emit("ask-user", question);

    match rx.await {
        Ok(answer) => ExecuteToolResult {
            output: answer,
            is_error: false,
        },
        Err(_) => ExecuteToolResult {
            output: "用户取消了输入".into(),
            is_error: true,
        },
    }
}

fn collect_files_recursive(
    dir: &Path,
    re: &regex::Regex,
    results: &mut Vec<String>,
    max_results: usize,
    depth: usize,
) {
    if depth > 6 || results.len() >= max_results {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if results.len() >= max_results {
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if re.is_match(&name) {
                results.push(entry.path().to_string_lossy().to_string());
            }
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                collect_files_recursive(&entry.path(), re, results, max_results, depth + 1);
            }
        }
    }
}

async fn file_search(args: serde_json::Value) -> ExecuteToolResult {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return ExecuteToolResult {
                output: "缺少 path 参数".into(),
                is_error: true,
            };
        }
    };
    let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return ExecuteToolResult {
                output: "缺少 pattern 参数".into(),
                is_error: true,
            };
        }
    };

    let re = match regex::Regex::new(pattern) {
        Ok(r) => r,
        Err(e) => {
            return ExecuteToolResult {
                output: format!("正则表达式无效: {}", e),
                is_error: true,
            };
        }
    };

    let dir_path = Path::new(path);
    if !dir_path.exists() {
        return ExecuteToolResult {
            output: format!("路径不存在: {}", path),
            is_error: true,
        };
    }

    let mut results = Vec::new();
    if dir_path.is_dir() {
        collect_files_recursive(dir_path, &re, &mut results, 200, 0);
    } else if let Some(name) = dir_path.file_name().and_then(|n| n.to_str()) {
        if re.is_match(name) {
            results.push(path.to_string());
        }
    }

    if results.is_empty() {
        ExecuteToolResult {
            output: "未找到匹配的文件".into(),
            is_error: false,
        }
    } else {
        let mut output = results.join("\n");
        if results.len() >= 200 {
            output.push_str(&format!(
                "\n... (仅显示前 {} 条结果)",
                results.len()
            ));
        }
        ExecuteToolResult {
            output,
            is_error: false,
        }
    }
}

async fn grep(args: serde_json::Value) -> ExecuteToolResult {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return ExecuteToolResult {
                output: "缺少 path 参数".into(),
                is_error: true,
            };
        }
    };
    let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return ExecuteToolResult {
                output: "缺少 pattern 参数".into(),
                is_error: true,
            };
        }
    };

    let re = match regex::Regex::new(pattern) {
        Ok(r) => r,
        Err(e) => {
            return ExecuteToolResult {
                output: format!("正则表达式无效: {}", e),
                is_error: true,
            };
        }
    };

    let dir_path = Path::new(path);
    if !dir_path.exists() {
        return ExecuteToolResult {
            output: format!("路径不存在: {}", path),
            is_error: true,
        };
    }

    let max_results = 100;
    let mut results = Vec::new();

    let entries: Vec<_> = if dir_path.is_file() {
        vec![dir_path.to_path_buf()]
    } else {
        match fs::read_dir(dir_path) {
            Ok(e) => e.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
            Err(_) => Vec::new(),
        }
    };

    for entry_path in entries {
        if results.len() >= max_results {
            break;
        }
        if entry_path.is_file() {
            if let Ok(content) = fs::read_to_string(&entry_path) {
                for (line_no, line) in content.lines().enumerate() {
                    if re.is_match(line) {
                        let trimmed = line.trim();
                        let preview: String = trimmed.chars().take(200).collect();
                        results.push(format!("{}:{}:{}", entry_path.display(), line_no + 1, preview));
                        if results.len() >= max_results {
                            break;
                        }
                    }
                }
            }
        }
    }

    if results.is_empty() {
        ExecuteToolResult {
            output: "未找到匹配的内容".into(),
            is_error: false,
        }
    } else {
        let mut output = results.join("\n");
        if results.len() >= max_results {
            output.push_str(&format!("\n... (最多显示 {} 条结果)", max_results));
        }
        ExecuteToolResult {
            output,
            is_error: false,
        }
    }
}

async fn screenshot(args: serde_json::Value) -> ExecuteToolResult {
    let _ = args;
    let temp_dir = std::env::temp_dir();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let screenshot_path = temp_dir.join(format!("screenshot_{}.png", timestamp));

    let result = if cfg!(target_os = "macos") {
        Command::new("screencapture")
            .args(["-x", screenshot_path.to_str().unwrap()])
            .output()
    } else if cfg!(target_os = "windows") {
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             [Windows.Forms.SendKeys]::SendWait('{{PRTSC}}'); \
             Start-Sleep 1; \
             $img = [Windows.Forms.Clipboard]::GetImage(); \
             $img.Save('{}')",
            screenshot_path.to_str().unwrap()
        );
        Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
    } else {
        Command::new("import")
            .args(["-window", "root", screenshot_path.to_str().unwrap()])
            .output()
    };

    match result {
        Ok(out) if out.status.success() => match fs::read(&screenshot_path) {
            Ok(bytes) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let data_url = format!("data:image/png;base64,{}", b64);
                let _ = fs::remove_file(&screenshot_path);
                ExecuteToolResult {
                    output: data_url,
                    is_error: false,
                }
            }
            Err(e) => ExecuteToolResult {
                output: format!("读取截图文件失败: {}", e),
                is_error: true,
            },
        },
        Ok(out) => ExecuteToolResult {
            output: format!(
                "截图命令失败: {}",
                String::from_utf8_lossy(&out.stderr)
            ),
            is_error: true,
        },
        Err(e) => ExecuteToolResult {
            output: format!("执行截图命令失败: {}", e),
            is_error: true,
        },
    }
}

async fn read_pdf_or_image(args: serde_json::Value) -> ExecuteToolResult {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return ExecuteToolResult {
                output: "缺少 path 参数".into(),
                is_error: true,
            };
        }
    };

    let file_path = Path::new(path);
    if !file_path.exists() {
        return ExecuteToolResult {
            output: format!("文件不存在: {}", path),
            is_error: true,
        };
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tiff" | "tif" | "ico" => {
            match image::open(file_path) {
                Ok(img) => {
                    let (w, h) = img.dimensions();
                    let color = format!("{:?}", img.color());
                    let file_size = fs::metadata(file_path)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    ExecuteToolResult {
                        output: format!(
                            "格式: {}\n尺寸: {}x{}\n颜色: {:?}\n文件大小: {} 字节\n路径: {}",
                            ext, w, h, color, file_size, path
                        ),
                        is_error: false,
                    }
                }
                Err(e) => ExecuteToolResult {
                    output: format!("读取图片失败: {}", e),
                    is_error: true,
                },
            }
        }
        "pdf" => {
            let result = Command::new("pdftotext")
                .args([path, "-"])
                .output();
            match result {
                Ok(out) if out.status.success() => {
                    let text = String::from_utf8_lossy(&out.stdout).to_string();
                    let cleaned: String = text.chars().take(10000).collect();
                    let mut output = format!("PDF 内容:\n");
                    output.push_str(&cleaned);
                    if text.len() > 10000 {
                        output.push_str(&format!(
                            "\n... (剩余 {} 字符已截断)",
                            text.len() - 10000
                        ));
                    }
                    ExecuteToolResult {
                        output,
                        is_error: false,
                    }
                }
                _ => {
                    let file_size = fs::metadata(file_path)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    ExecuteToolResult {
                        output: format!(
                            "PDF 文件 ({} 字节)\n路径: {}\n提示: 安装 poppler-utils 以启用文本提取 (macOS: brew install poppler)",
                            file_size, path
                        ),
                        is_error: false,
                    }
                }
            }
        }
        _ => {
            let file_size = fs::metadata(file_path)
                .map(|m| m.len())
                .unwrap_or(0);
            ExecuteToolResult {
                output: format!(
                    "二进制文件\n类型: {}\n大小: {} 字节\n路径: {}",
                    if ext.is_empty() { "未知" } else { &ext },
                    file_size,
                    path
                ),
                is_error: false,
            }
        }
    }
}
