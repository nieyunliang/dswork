use std::collections::BTreeMap;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::config::load_config;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    #[serde(default)]
    pub id: String,
    pub role: String,
    pub content: Option<String>,
    /// 模型调用工具前的推理文本，仅用于展示与持久化；发给 DeepSeek 前会被剥离。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// 检索上下文片段，仅用于展示与持久化；发给 DeepSeek 前会被剥离。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Vec<ContextChunk>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 该轮请求的 token 用量与上下文缓存统计（仅展示与持久化；发送时被剥离）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageStats>,
}

/// 单次请求的 token 用量与上下文缓存统计（与前端 src/types.ts 的 UsageStats 保持一致）。
/// 由流式响应的最后一个 chunk（stream_options.include_usage）携带，
/// 或从非流式响应的 usage 字段解析。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct UsageStats {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    /// 命中上下文缓存的 prompt tokens（计费价更低）
    #[serde(default)]
    pub prompt_cache_hit_tokens: u64,
    /// 未命中缓存的 prompt tokens（按原价计费）
    #[serde(default)]
    pub prompt_cache_miss_tokens: u64,
}

/// 流式响应事件：通过 Tauri Channel 按请求独立下发。
/// 每个请求绑定自己的 Channel，事件不再走全局总线（chat-chunk 等全局事件
/// 会让聊天与后台任务两个并发请求互相串台，且 usage 归属错乱）。
/// 与前端 src/types.ts 的 StreamEvent 双端镜像。
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Chunk { text: String },
    Reasoning { text: String },
    /// 携带完整 UsageStats 字段（内部标签枚举会把字段内联进事件对象）。
    Usage(UsageStats),
    /// 一轮结束；tool_calls 为空表示普通文本答复。
    Done { tool_calls: Vec<ToolCall> },
    /// 请求失败（命令同时返回 Err，前端任一通道先到先处理）。
    Error { message: String },
}

/// 流式 usage 的宽松解析目标：OpenAI 兼容端点可能用
/// `prompt_tokens_details.cached_tokens` 而非 DeepSeek 的
/// `prompt_cache_hit_tokens`，统一归一化后再使用。
#[derive(Debug, Deserialize, Default)]
struct RawUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    prompt_cache_hit_tokens: u64,
    #[serde(default)]
    prompt_cache_miss_tokens: u64,
    #[serde(default)]
    prompt_tokens_details: Option<serde_json::Value>,
}

impl RawUsage {
    fn normalize(self) -> UsageStats {
        let mut hit = self.prompt_cache_hit_tokens;
        let mut miss = self.prompt_cache_miss_tokens;
        // DeepSeek 字段缺失时，回退到 OpenAI 的 cached_tokens 形状
        if hit == 0 && miss == 0 {
            if let Some(cached) = self
                .prompt_tokens_details
                .as_ref()
                .and_then(|d| d.get("cached_tokens"))
                .and_then(|c| c.as_u64())
            {
                hit = cached;
                miss = self.prompt_tokens.saturating_sub(cached);
            }
        }
        UsageStats {
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            total_tokens: self.total_tokens,
            prompt_cache_hit_tokens: hit,
            prompt_cache_miss_tokens: miss,
        }
    }
}

/// 请求体白名单：发送给 DeepSeek 的每条消息只允许这些标准字段。
/// 内部字段（id / reasoning / context / usage）一律剥离，确保请求字节只由
/// 语义内容决定——system 消息每轮重建（新 UUID）不再破坏服务端前缀缓存。
const API_MESSAGE_ALLOWED_FIELDS: [&str; 5] = ["role", "content", "name", "tool_calls", "tool_call_id"];

/// 把内部 ChatMessage 白名单化为 API 请求体消息：只保留标准字段，其余全剥。
fn to_api_message(m: &ChatMessage) -> serde_json::Value {
    let mut v = serde_json::to_value(m).unwrap_or_default();
    if let Some(obj) = v.as_object_mut() {
        obj.retain(|k, _| API_MESSAGE_ALLOWED_FIELDS.contains(&k.as_str()));
    }
    v
}

/// FNV-1a 64-bit 指纹：system 消息 + tools 数组的稳定字节指纹。
/// 用途：缓存断裂诊断——历史消息的 append-only 可由会话数据审计，但 system/tools
/// 前缀在持久化数据里不可见（skill 激活/回退、推理等级映射都可能改变它）。
/// 相邻两次请求指纹不一致 = 前缀变了，该次请求的缓存必然整段失效。
/// （确定性哈希，不依赖进程随机种子，跨重启日志可比对。）
fn prefix_fingerprint(
    api_messages: &[serde_json::Value],
    tools: Option<&Vec<serde_json::Value>>,
) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for m in api_messages {
        if m.get("role").and_then(|r| r.as_str()) == Some("system") {
            let bytes = m.to_string();
            for &b in bytes.as_bytes() {
                hash ^= b as u64;
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
    }
    if let Some(tools) = tools {
        let bytes = serde_json::to_string(tools).unwrap_or_default();
        for &b in bytes.as_bytes() {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

/// 检索上下文片段（与前端 src/types.ts 的 ContextChunk 保持一致）。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContextChunk {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub title: String,
    pub body: String,
    pub source: String,
    pub badge: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chars: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub function: ToolCallFunction,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionInput {
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
    /// 推理等级（与前端 src/types.ts 的 ReasoningLevel 镜像）：off=关闭思考，
    /// high=标准推理（DeepSeek 默认），max=深度推理。
    /// 映射为请求体 thinking: { type, reasoning_effort }；None 时不发送该参数。
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_level: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionInput {
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TestConnectionResult {
    success: bool,
    message: String,
}

fn format_http_error(status: reqwest::StatusCode, body_text: String) -> String {
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return "API Key 无效或已过期，请检查后重试".into();
    }

    if status.as_u16() == 429 {
        return "请求过于频繁或额度不足，请稍后重试".into();
    }

    let body_preview: String = body_text.chars().take(500).collect();
    format!("请求失败 ({}): {}", status, body_preview)
}

#[tauri::command]
pub async fn test_deepseek_connection(
    input: Option<TestConnectionInput>,
) -> Result<TestConnectionResult, String> {
    let (base_url, model, api_key) = if let Some(input) = input {
        (input.base_url, input.model, input.api_key)
    } else {
        let config = load_config().map_err(|e| format!("无法加载配置: {}", e))?;
        if config.api_key.is_empty() {
            return Ok(TestConnectionResult {
                success: false,
                message: "未配置 API Key".into(),
            });
        }
        (config.base_url, config.model, config.api_key)
    };

    let client = crate::http_client();

    let base_url = base_url.trim_end_matches('/').to_string();
    let url = format!("{}/v1/chat/completions", base_url);

    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "test"}],
        "max_tokens": 1
    });

    let response = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(15))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await;

    match response {
        Ok(resp) => {
            if resp.status().is_success() {
                Ok(TestConnectionResult {
                    success: true,
                    message: "连接成功".into(),
                })
            } else {
                let status = resp.status();
                let body_text = resp.text().await.unwrap_or_default();
                Ok(TestConnectionResult {
                    success: false,
                    message: format_http_error(status, body_text),
                })
            }
        }
        Err(e) => {
            if e.is_timeout() {
                Ok(TestConnectionResult {
                    success: false,
                    message: "连接超时，请检查网络或 Base URL 配置".into(),
                })
            } else if e.is_connect() {
                Ok(TestConnectionResult {
                    success: false,
                    message: "无法连接到服务器，请检查网络或 Base URL 配置".into(),
                })
            } else {
                Ok(TestConnectionResult {
                    success: false,
                    message: format!("连接失败: {}", e),
                })
            }
        }
    }
}

/// 推理等级 → DeepSeek thinking 参数：
///   off  → type=disabled（关闭思考）
///   high → type=enabled + reasoning_effort=high（标准推理）
///   max  → type=enabled + reasoning_effort=max（深度推理）
/// None（未传）→ 不发送该参数，由端点默认行为决定，保持向后兼容。
fn reasoning_to_thinking(level: Option<&str>) -> Option<serde_json::Value> {
    let (thinking_type, reasoning_effort) = match level? {
        "off" => ("disabled", None),
        "max" => ("enabled", Some("max")),
        // "high" 及未知值：标准推理
        _ => ("enabled", Some("high")),
    };
    let mut thinking = serde_json::json!({ "type": thinking_type });
    if let Some(effort) = reasoning_effort {
        thinking["reasoning_effort"] = serde_json::json!(effort);
    }
    Some(thinking)
}

#[tauri::command]
pub async fn send_deepseek_chat(
    input: ChatCompletionInput,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    if input.messages.is_empty() {
        return Err("消息不能为空".into());
    }

    let config = load_config().map_err(|e| format!("无法加载配置: {}", e))?;
    if config.api_key.trim().is_empty() {
        return Err("未配置 API Key".into());
    }

    let base_url = config.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Base URL 不能为空".into());
    }

    // 全局复用客户端：连接池跨请求复用；超时按请求设置。
    let client = crate::http_client();

    let url = format!("{}/v1/chat/completions", base_url);

    // 请求体白名单：发给 DeepSeek 的消息只保留 OpenAI/DeepSeek 标准字段。
    // id（前端 UUID）、reasoning/context/usage（仅展示/持久化）一律剥离——
    // 保证请求字节只由语义内容决定，system 消息每轮重建（新 UUID）不会破坏
    // 服务端前缀缓存（与 deepseek-harness 的 reconstructable requests 原则一致）。
    let api_messages: Vec<serde_json::Value> = input.messages.iter().map(to_api_message).collect();

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": api_messages,
        "stream": true,
        // 流式响应默认不携带 usage，需显式要求：最后一个 chunk 会返回 usage，
        // 其中包含上下文缓存统计（prompt_cache_hit_tokens / prompt_cache_miss_tokens）。
        "stream_options": { "include_usage": true },
    });

    if let Some(tools) = input.tools.as_ref() {
        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
        }
    }

    // 推理等级 → DeepSeek thinking 参数（映射逻辑见 reasoning_to_thinking）
    if let Some(thinking) = reasoning_to_thinking(input.reasoning_level.as_deref()) {
        body["thinking"] = thinking;
    }

    let response = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(120))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let err = if e.is_timeout() {
                "请求超时，请稍后重试".into()
            } else if e.is_connect() {
                "无法连接到服务器，请检查网络或 Base URL 配置".into()
            } else {
                format!("请求失败: {}", e)
            };
            let _ = on_event.send(StreamEvent::Error { message: err.clone() });
            err
        })?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.map_err(|e| e.to_string())?;
        let err = format_http_error(status, body_text);
        let _ = on_event.send(StreamEvent::Error { message: err.clone() });
        return Err(err);
    }

    // 用字节缓冲累积流式响应，再按完整行解码：一个 UTF-8 多字节字符可能被拆到两个
    // 网络 chunk 里，若对每个 chunk 单独 from_utf8_lossy，不完整的字节序列会被替换成
    // U+FFFD（�），造成乱码。SSE 行以 \n 结尾，而 0x0A 不可能出现在 UTF-8 多字节
    // 序列内部，因此只有拿到完整行（含 \n）后再解码才是安全的。
    let mut buf: Vec<u8> = Vec::new();
    let mut tool_calls_map: BTreeMap<usize, ToolCall> = BTreeMap::new();
    // usage 可能出现在最后一个 chunk（stream_options.include_usage），也可能在
    // 非标准端点上出现在任意 chunk；取最后一次看到的完整 usage。
    let mut last_usage: Option<UsageStats> = None;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| {
            let err = format!("流读取失败: {}", e);
            let _ = on_event.send(StreamEvent::Error { message: err.clone() });
            err
        })?;

        buf.extend_from_slice(&chunk);

        while let Some(newline_idx) = buf.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&buf[..newline_idx]).trim().to_string();
            buf.drain(..=newline_idx);

            if line.is_empty() {
                continue;
            }

            if !line.starts_with("data: ") {
                continue;
            }

            let data = &line[6..];
            if data == "[DONE]" {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(usage_val) = json.get("usage") {
                    if !usage_val.is_null() {
                        if let Ok(raw) = serde_json::from_value::<RawUsage>(usage_val.clone()) {
                            let normalized = raw.normalize();
                            if normalized.prompt_tokens > 0 || normalized.total_tokens > 0 {
                                last_usage = Some(normalized);
                            }
                        }
                    }
                }
                if let Some(choices) = json.get("choices").and_then(|c| c.as_array()) {
                    if let Some(choice) = choices.first() {
                        if let Some(delta) = choice.get("delta") {
                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                if !content.is_empty() {
                                    let _ = on_event.send(StreamEvent::Chunk {
                                        text: content.to_string(),
                                    });
                                }
                            }

                            if let Some(reasoning) = delta
                                .get("reasoning_content")
                                .and_then(|r| r.as_str())
                            {
                                if !reasoning.is_empty() {
                                    let _ = on_event.send(StreamEvent::Reasoning {
                                        text: reasoning.to_string(),
                                    });
                                }
                            }

                            if let Some(tool_calls_val) = delta.get("tool_calls") {
                                if let Some(tool_calls_array) = tool_calls_val.as_array() {
                                    for tc in tool_calls_array {
                                        let index = tc.get("index").and_then(|i| i.as_i64()).unwrap_or(0) as usize;
                                        let entry = tool_calls_map.entry(index).or_insert_with(|| ToolCall {
                                            id: String::new(),
                                            type_: "function".to_string(),
                                            function: ToolCallFunction {
                                                name: String::new(),
                                                arguments: String::new(),
                                            },
                                        });

                                        if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                                            if !id.is_empty() {
                                                entry.id = id.to_string();
                                            }
                                        }
                                        if let Some(type_) = tc.get("type").and_then(|t| t.as_str()) {
                                            if !type_.is_empty() {
                                                entry.type_ = type_.to_string();
                                            }
                                        }
                                        if let Some(function) = tc.get("function") {
                                            if let Some(name) = function.get("name").and_then(|n| n.as_str()) {
                                                if !name.is_empty() {
                                                    entry.function.name = name.to_string();
                                                }
                                            }
                                            if let Some(args) = function.get("arguments").and_then(|a| a.as_str()) {
                                                if !args.is_empty() {
                                                    entry.function.arguments.push_str(args);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let tool_calls: Vec<ToolCall> = tool_calls_map.into_values().collect();
    // 缓存诊断：system+tools 前缀指纹 + 实测 usage。
    // 相邻请求指纹不一致 = 前缀被静默改写（skill 激活/回退、推理等级变化…），
    // 该次请求命中率必然骤降；配合 scripts/cache-audit 可定位断裂点。
    let usage = last_usage.as_ref();
    let fingerprint = prefix_fingerprint(&api_messages, input.tools.as_ref());
    let sys_msgs = api_messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("system"))
        .count();
    let tools_count = input.tools.as_ref().map_or(0, |t| t.len());
    eprintln!(
        "[cache] prefix={:016x} sys_msgs={} tools={} prompt={} hit={} miss={}",
        fingerprint,
        sys_msgs,
        tools_count,
        usage.map_or(0, |u| u.prompt_tokens),
        usage.map_or(0, |u| u.prompt_cache_hit_tokens),
        usage.map_or(0, |u| u.prompt_cache_miss_tokens),
    );
    // 同一信息落盘为结构化日志（~/.dswork/cache-audit.jsonl，scripts/cache-audit
    // 的 --log 模式消费）：跨重启留存、可离线聚合断裂事件（指纹变化 = 前缀被改写）。
    // 日志写入失败不影响请求（尽力而为）。
    let log_line = serde_json::json!({
        "ts": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
        "model": config.model,
        "prefix": format!("{:016x}", fingerprint),
        "sys_msgs": sys_msgs,
        "tools": tools_count,
        "prompt_tokens": usage.map_or(0, |u| u.prompt_tokens),
        "hit": usage.map_or(0, |u| u.prompt_cache_hit_tokens),
        "miss": usage.map_or(0, |u| u.prompt_cache_miss_tokens),
    })
    .to_string();
    if let Ok(dir) = crate::dswork_dir() {
        let path = dir.join("cache-audit.jsonl");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = writeln!(f, "{}", log_line);
        }
    }
    // 上下文缓存统计先于 Done 发出：前端在收到 done 前应已拿到 usage（同一 Channel
    // 内发送有序，且 Channel 在 invoke 前就已绑定，不存在监听注册竞态）。
    if let Some(usage) = last_usage {
        let _ = on_event.send(StreamEvent::Usage(usage));
    }
    let _ = on_event.send(StreamEvent::Done { tool_calls });

    Ok(())
}

#[tauri::command]
pub async fn summarize_messages(messages: Vec<ChatMessage>) -> Result<String, String> {
    let config = load_config().map_err(|e| format!("无法加载配置: {}", e))?;
    if config.api_key.trim().is_empty() {
        return Err("未配置 API Key".into());
    }

    let base_url = config.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Base URL 不能为空".into());
    }

    let client = crate::http_client();

    let url = format!("{}/v1/chat/completions", base_url);

    fn truncate(s: &str, max: usize) -> String {
        let t: String = s.chars().take(max).collect();
        if s.chars().count() > max {
            format!("{}…", t)
        } else {
            t
        }
    }

    let sanitized: Vec<serde_json::Value> = messages
        .iter()
        .filter_map(|m| {
            let role = match m.role.as_str() {
                "user" => "用户",
                "assistant" => "助手",
                "tool" => "工具",
                "system" => "系统",
                _ => return None,
            };
            let text = match m.role.as_str() {
                "tool" => {
                    let name = m.name.as_deref().unwrap_or("tool");
                    let content = m.content.as_deref().unwrap_or("");
                    format!("[工具 {} 执行结果]: {}", name, truncate(content, 800))
                }
                "assistant" => match &m.content {
                    Some(c) if !c.is_empty() => c.clone(),
                    _ => {
                        let names: Vec<&str> = m
                            .tool_calls
                            .as_ref()
                            .map(|tcs| {
                                tcs.iter()
                                    .map(|tc| tc.function.name.as_str())
                                    .collect()
                            })
                            .unwrap_or_default();
                        if names.is_empty() {
                            return None;
                        }
                        format!("[工具调用: {}]", names.join(", "))
                    }
                },
                _ => m.content.as_deref().unwrap_or("").to_string(),
            };
            Some(serde_json::json!({
                "role": m.role,
                "content": format!("{}: {}", role, truncate(&text, 2000)),
            }))
        })
        .collect();

    if sanitized.is_empty() {
        return Err("没有可压缩的消息".into());
    }

    let body = serde_json::json!({
        "model": config.model,
        "messages": [
            {"role": "system", "content": "你是一个对话压缩器。根据以下对话历史(包含用户问题、助手回复、工具调用结果)生成一段简洁的中文摘要。必须保留:用户的真实意图与需求、已完成的决策与结论、涉及的文件路径/命令/关键数据、尚未完成或待办的事项、存在的错误。控制在500字以内,直接输出摘要正文,不要使用标题、列表符号或任何前言。"},
            {"role": "user", "content": serde_json::to_string(&sanitized).unwrap_or_default()}
        ],
        "max_tokens": 512,
        "stream": false,
        "temperature": 0.3,
    });

    let response = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(60))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("摘要生成请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!(
            "摘要生成请求失败 ({}): {}",
            status,
            body_text.chars().take(200).collect::<String>()
        ));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    let summary = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    if summary.is_empty() {
        Err("生成的摘要为空".into())
    } else {
        Ok(summary)
    }
}

pub async fn generate_title(messages: Vec<ChatMessage>) -> Result<String, String> {
    let config = load_config().map_err(|e| format!("无法加载配置: {}", e))?;
    if config.api_key.trim().is_empty() {
        return Err("未配置 API Key".into());
    }

    let base_url = config.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Base URL 不能为空".into());
    }

    let client = crate::http_client();

    let url = format!("{}/v1/chat/completions", base_url);

    let conversation: String = messages.iter()
        .filter_map(|m| {
            let role = match m.role.as_str() {
                "user" => "用户",
                "assistant" => "助手",
                _ => return None,
            };
            m.content.as_ref().map(|c| format!("{}: {}", role, c))
        })
        .collect::<Vec<_>>()
        .join("\n");

    let body = serde_json::json!({
        "model": config.model,
        "messages": [
            {"role": "system", "content": "你是一个对话标题生成器。根据以下对话内容，生成一个不超过20个字的简短标题，直接返回标题内容，不要加引号或其他格式。"},
            {"role": "user", "content": conversation}
        ],
        "max_tokens": 30,
        "stream": false,
        "temperature": 0.3,
    });

    let response = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(15))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("标题生成请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("标题生成请求失败 ({}): {}", status, body_text.chars().take(200).collect::<String>()));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
    let title = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .trim()
        .to_string();

    if title.is_empty() {
        Err("生成的标题为空".into())
    } else {
        Ok(title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(json: serde_json::Value) -> RawUsage {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn normalize_deepseek_native_fields() {
        // DeepSeek 官方端点：prompt_cache_hit_tokens / prompt_cache_miss_tokens 直接采用
        let u = raw(serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
            "prompt_cache_hit_tokens": 70,
            "prompt_cache_miss_tokens": 30,
        }));
        let s = u.normalize();
        assert_eq!(s.prompt_tokens, 100);
        assert_eq!(s.completion_tokens, 20);
        assert_eq!(s.prompt_cache_hit_tokens, 70);
        assert_eq!(s.prompt_cache_miss_tokens, 30);
    }

    #[test]
    fn normalize_openai_cached_tokens_fallback() {
        // OpenAI 兼容端点：只给 prompt_tokens_details.cached_tokens，需回退推导 miss
        let u = raw(serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
            "prompt_tokens_details": { "cached_tokens": 60 },
        }));
        let s = u.normalize();
        assert_eq!(s.prompt_cache_hit_tokens, 60);
        assert_eq!(s.prompt_cache_miss_tokens, 40); // 100 - 60
    }

    #[test]
    fn normalize_no_cache_fields() {
        let u = raw(serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
        }));
        let s = u.normalize();
        assert_eq!(s.prompt_cache_hit_tokens, 0);
        assert_eq!(s.prompt_cache_miss_tokens, 0);
    }

    fn sample_message() -> ChatMessage {
        ChatMessage {
            id: "uuid-123".into(),
            role: "assistant".into(),
            content: Some("hello".into()),
            reasoning: Some("think...".into()),
            context: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            usage: Some(UsageStats::default()),
        }
    }

    #[test]
    fn to_api_message_whitelist_strips_internal_fields() {
        let v = to_api_message(&sample_message());
        let obj = v.as_object().unwrap();
        assert_eq!(obj.get("role").unwrap(), "assistant");
        assert_eq!(obj.get("content").unwrap(), "hello");
        // 内部字段必须剥离：id / reasoning / usage
        assert!(obj.get("id").is_none());
        assert!(obj.get("reasoning").is_none());
        assert!(obj.get("usage").is_none());
        assert!(obj.get("context").is_none());
        // 白名单集合精确匹配
        let keys: Vec<&String> = obj.keys().collect();
        assert_eq!(keys.len(), 2);
    }

    #[test]
    fn to_api_message_keeps_standard_fields() {
        let mut m = sample_message();
        m.tool_calls = Some(vec![ToolCall {
            id: "call_1".into(),
            type_: "function".into(),
            function: ToolCallFunction { name: "read_file".into(), arguments: "{}".into() },
        }]);
        m.tool_call_id = Some("call_1".into());
        m.name = Some("read_file".into());
        let obj = to_api_message(&m).as_object().unwrap().clone();
        assert_eq!(obj.len(), 5);
        assert!(obj.contains_key("role"));
        assert!(obj.contains_key("content"));
        assert!(obj.contains_key("name"));
        assert!(obj.contains_key("tool_calls"));
        assert!(obj.contains_key("tool_call_id"));
        assert!(!obj.contains_key("id"));
        assert!(!obj.contains_key("usage"));
        assert!(!obj.contains_key("reasoning"));
    }

    #[test]
    fn prefix_fingerprint_deterministic_and_sensitive() {
        let sys = serde_json::json!({"role": "system", "content": "你是助手"});
        let user = serde_json::json!({"role": "user", "content": "你好"});
        let tools = vec![serde_json::json!({"type": "function", "function": {"name": "read_file"}})];

        let msgs = vec![sys.clone(), user.clone()];
        let a = prefix_fingerprint(&msgs, Some(&tools));
        // 确定性：相同输入 → 相同指纹
        assert_eq!(a, prefix_fingerprint(&msgs, Some(&tools)));
        // 非 system 消息不参与指纹（历史 append 不改变前缀指纹）
        assert_eq!(a, prefix_fingerprint(&vec![sys.clone()], Some(&tools)));
        // system 内容变化 → 指纹变化（skill 激活/回退的信号）
        let sys2 = serde_json::json!({"role": "system", "content": "你是助手\n技能正文..."});
        assert_ne!(a, prefix_fingerprint(&vec![sys2.clone()], Some(&tools)));
        // tools 变化 → 指纹变化（selectTools 收缩/还原的信号）
        let tools2 = vec![serde_json::json!({"type": "function", "function": {"name": "grep"}})];
        assert_ne!(a, prefix_fingerprint(&vec![sys.clone()], Some(&tools2)));
    }

    #[test]
    fn reasoning_to_thinking_off() {
        // off → 关闭思考，不带 reasoning_effort
        let v = reasoning_to_thinking(Some("off")).unwrap();
        assert_eq!(v["type"], "disabled");
        assert!(v.get("reasoning_effort").is_none());
    }

    #[test]
    fn reasoning_to_thinking_high_and_max() {
        // high → enabled + reasoning_effort=high（标准推理）
        let high = reasoning_to_thinking(Some("high")).unwrap();
        assert_eq!(high["type"], "enabled");
        assert_eq!(high["reasoning_effort"], "high");

        // max → enabled + reasoning_effort=max（深度推理）
        let max = reasoning_to_thinking(Some("max")).unwrap();
        assert_eq!(max["type"], "enabled");
        assert_eq!(max["reasoning_effort"], "max");
    }

    #[test]
    fn reasoning_to_thinking_none_or_unknown() {
        // 未传 → 不发送该参数
        assert!(reasoning_to_thinking(None).is_none());
        // 未知值回退为标准推理，不报错
        let v = reasoning_to_thinking(Some("bogus")).unwrap();
        assert_eq!(v["type"], "enabled");
        assert_eq!(v["reasoning_effort"], "high");
    }

    #[test]
    fn stream_event_type_tags_and_fields() {
        // 前端按 { type, ...fields } 解析：type 标签 + 字段内联（含 UsageStats 全字段）
        let usage = StreamEvent::Usage(UsageStats {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_cache_hit_tokens: 70,
            prompt_cache_miss_tokens: 30,
        });
        let v = serde_json::to_value(usage).unwrap();
        assert_eq!(v["type"], "usage");
        assert_eq!(v["prompt_tokens"], 100);
        assert_eq!(v["prompt_cache_hit_tokens"], 70);
        assert_eq!(v["prompt_cache_miss_tokens"], 30);

        let done = StreamEvent::Done {
            tool_calls: vec![ToolCall {
                id: "call_1".into(),
                type_: "function".into(),
                function: ToolCallFunction { name: "read_file".into(), arguments: "{}".into() },
            }],
        };
        let v = serde_json::to_value(done).unwrap();
        assert_eq!(v["type"], "done");
        assert_eq!(v["tool_calls"][0]["function"]["name"], "read_file");

        let chunk = StreamEvent::Chunk { text: "你好".into() };
        let v = serde_json::to_value(chunk).unwrap();
        assert_eq!(v["type"], "chunk");
        assert_eq!(v["text"], "你好");

        let err = StreamEvent::Error { message: "boom".into() };
        let v = serde_json::to_value(err).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["message"], "boom");
    }
}
