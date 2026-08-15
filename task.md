1. tools.rs 扩展性改进
  
  问题根源：工具的路由和实现混在一个 match 里，新增工具必须改核心函数。
     
  改法：用 trait + 注册表解耦：

  // tools.rs
  type ToolFn = fn(serde_json::Value) -> std::pin::Pin<
      Box<dyn std::future::Future<Output = ExecuteToolResult> + Send>,
  >;

  fn registry() -> std::collections::HashMap<&'static str, ToolFn> {
      let mut m: std::collections::HashMap<&'static str, ToolFn> = std::collections::HashMap::new();
      m.insert("read_file", |args| Box::pin(read_file(args)));
      m.insert("write_file", |args| Box::pin(write_file(args)));
      m.insert("list_dir", |args| Box::pin(list_dir(args)));
      m.insert("run_shell", |args| Box::pin(run_shell(args)));
      m.insert("http_get", |args| Box::pin(http_get(args)));
      m
  }

  #[tauri::command]
  pub async fn execute_tool(input: ExecuteToolInput) -> ExecuteToolResult {
      let args: serde_json::Value = match serde_json::from_str(&input.arguments) {
          Ok(v) => v,
          Err(e) => return ExecuteToolResult { output: format!("参数解析失败: {}", e), is_error: true },
      };
      match registry().get(input.name.as_str()) {
          Some(f) => f(args).await,
          None => ExecuteToolResult { output: format!("未知工具: {}", input.name), is_error: true },
      }
  }

  <thinking>
  Now each tool (read_file, write_file, etc.) becomes its own `async fn`, and the registry maps names to them. Adding a new tool = write one function + add one line to
  registry(). The `execute_tool` entry point never needs to change.

  For streaming, let me think about the implementation.
  </thinking>

  新增工具只需：写一个 async fn new_tool(args: Value) -> ExecuteToolResult，再往registry() 加一行，execute_tool 本身不用动。