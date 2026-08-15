# 自动更新（GitHub Releases + tauri-plugin-updater）

dswork 使用 Tauri v2 官方 `tauri-plugin-updater` 实现自动更新：
app 启动后静默检查、每 4 小时自动复查、设置中可手动检查；
发现新版本时标题栏出现「vX.Y.Z 可更新」badge，点击弹窗下载并安装，完成后自动重启。

- 更新端点：`https://github.com/nieyunliang/dswork/releases/latest/download/latest.json`
- 支持平台：macOS（Apple Silicon + Intel）、Windows（NSIS，passive 静默安装）
- 更新清单 `latest.json` 由 CI（`tauri-apps/tauri-action`）在发布时自动生成并上传

## 发布新版本（唯一流程）

```bash
# 一键发布：同步版本号 → 提交 → 推送 → 打 tag → 推送 tag（触发 CI）
pnpm release 0.2.0        # 或 pnpm release patch | minor | major
# 等价于手动执行：
#   pnpm bump 0.2.0 && git add -A && git commit -m "release v0.2.0"
#   git push origin main && git tag v0.2.0 && git push origin v0.2.0
```

CI 会在 macOS（arm64 + x86_64）与 Windows 上构建签名产物，并创建 **draft** Release：

1. 打开 https://github.com/nieyunliang/dswork/releases ，检查各平台资产齐全
2. 编辑 Release 说明（用户会在更新弹窗里看到这段 notes）
3. 点击 **Publish release** —— 发布后 `releases/latest/download/latest.json` 端点才生效，用户端才会检测到

> 版本号必须大于当前版本（semver 比较），且三处保持一致（`pnpm bump` 负责同步）。

## 一次性初始化（已完成，如换机/重建仓库需重做）

- 签名密钥：`pnpm exec tauri signer generate -w ~/.tauri/dswork.key`
  - 公钥已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
  - **私钥保存在 `~/.tauri/dswork.key`，绝不入库、绝不外传；丢失私钥 = 永远无法再发布更新**
- GitHub Secrets（仓库 Settings → Secrets and variables → Actions）：
  - `TAURI_SIGNING_PRIVATE_KEY`：`~/.tauri/dswork.key` 的**文件内容**
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成时未设密码则为空字符串

## 本地构建（验证/自用）

```bash
# 带签名构建（产物含 .sig 签名文件，updater 必须签名才能安装）
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/dswork.key)" pnpm tauri build
# macOS 产物在 src-tauri/target/release/bundle/macos/（dswork.app.tar.gz + .sig）
# Windows 产物为 target/release/bundle/nsis/dswork-setup.exe + .sig
```

`tauri dev` 下 updater 插件同样工作（会真实请求端点），可用来验证检查逻辑。

## 常见问题

- **Windows 上更新后没自动重启**：NSIS 安装器可能已接管并关闭应用，属预期；手动打开即可，下次启动即新版本
- **macOS 提示「无法打开，因为来自身份不明的开发者」**：未配置 Apple 代码签名所致（不影响更新机制）。需时在 CI 增加 `APPLE_*` secrets（证书/公证账号），见 [Tauri 官方文档](https://v2.tauri.app/distribute/pipelines/github/)
- **Windows SmartScreen 警告**：未配置代码签名证书的正常提示；「仍要运行」即可
- **最新版检测不到更新**：确认 Release 已 Publish（draft 不生效）、版本号高于当前安装版本、`latest.json` 资产存在
- **私钥轮换/更换**：重新生成密钥并把新公钥写入配置，同时更新 Secrets；已安装用户的旧版本将无法验证新签名（需要用户重新下载安装）

## 相关文件

| 文件 | 作用 |
|---|---|
| `.github/workflows/release.yml` | 打 tag 自动构建 + 发布（生成 latest.json） |
| `src-tauri/tauri.conf.json` | `bundle.createUpdaterArtifacts` + `plugins.updater` 配置 |
| `src/hooks/useUpdater.tsx` | 检查/下载/安装状态机（自动检查 + 手动触发） |
| `src/components/UpdateModal.tsx` | 更新弹窗（提示/进度/错误） |
| `scripts/bump-version.mjs` | 三处版本号同步（`pnpm bump`） |
