# 自动更新（GitHub Releases + tauri-plugin-updater）

dswork 使用 Tauri v2 官方 `tauri-plugin-updater` 实现自动更新：
app 启动后静默检查、每 4 小时自动复查、设置中可手动检查；
发现新版本时标题栏出现「vX.Y.Z 可更新」badge，点击弹窗下载并安装，完成后自动重启。

- 更新端点：`https://github.com/nieyunliang/dswork/releases/latest/download/latest.json`
- 支持平台：macOS（Apple Silicon + Intel）、Windows（NSIS，passive 静默安装）
- 架构匹配：客户端按自身平台取 `latest.json` 中 `platforms` 对应条目
  （`darwin-aarch64` = Apple Silicon，`darwin-x86_64` = Intel），不存在装错版本的可能

## 发布新版本（手动流程，无 CI）

自动发布链路（CI workflow / `pnpm release`）已移除，当前发布走本地打包 + 手动上传：

1. **同步版本号并本地打包**（两个架构都要）：

   ```bash
   pnpm bump 0.2.0          # 同步 package.json / Cargo.toml / tauri.conf.json
   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/dswork.key)" pnpm tauri build --bundles app,dmg --target aarch64-apple-darwin
   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/dswork.key)" pnpm tauri build --bundles app,dmg --target x86_64-apple-darwin
   ```

   updater 需要的资产（在 `src-tauri/target/<target>/release/bundle/macos/`）：
   `dswork.app.tar.gz` + `dswork.app.tar.gz.sig`（DMG 仅供手动安装，不用于自动更新）

2. **创建 GitHub Release**（tag 建议 `v0.2.0`），上传资产：
   - 两个架构的 `dswork.app.tar.gz` + `.sig`（共 4 个文件，可附 DMG）
   - `latest.json`（更新清单，见下文模板）

3. **发布 Release 后**，用户端才会从
   `https://github.com/nieyunliang/dswork/releases/latest/download/latest.json` 检测到更新
   （draft Release 不生效）。

### latest.json 模板

```json
{
  "version": "0.2.0",
  "notes": "本次更新说明（用户会在更新弹窗里看到）",
  "pub_date": "2026-08-15T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "（dswork.app.tar.gz.sig 的内容）",
      "url": "https://github.com/nieyunliang/dswork/releases/download/v0.2.0/dswork_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "（dswork.app.tar.gz.sig 的内容）",
      "url": "https://github.com/nieyunliang/dswork/releases/download/v0.2.0/dswork_x86_64.app.tar.gz"
    }
  }
}
```

> 版本号必须大于当前安装版本（semver 比较），且三处保持一致（`pnpm bump` 负责同步）。

## 一次性初始化（已完成，如换机/重建仓库需重做）

- 签名密钥：`pnpm exec tauri signer generate -w ~/.tauri/dswork.key`
  - 公钥已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
  - **私钥保存在 `~/.tauri/dswork.key`，绝不入库、绝不外传；丢失私钥 = 永远无法再发布更新**

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
- **macOS 提示「无法打开，因为来自身份不明的开发者」**：未配置 Apple 代码签名所致（不影响更新机制）。需时在打包机配置证书/公证账号，见 [Tauri 官方文档](https://v2.tauri.app/distribute/pipelines/github/)
- **Windows SmartScreen 警告**：未配置代码签名证书的正常提示；「仍要运行」即可
- **最新版检测不到更新**：确认 Release 已 Publish（draft 不生效）、版本号高于当前安装版本、`latest.json` 资产存在且 `platforms` 键与客户端架构匹配
- **私钥轮换/更换**：重新生成密钥并把新公钥写入配置；已安装用户的旧版本将无法验证新签名（需要用户重新下载安装）

## 相关文件

| 文件 | 作用 |
|---|---|
| `src-tauri/tauri.conf.json` | `bundle.createUpdaterArtifacts` + `plugins.updater` 配置 |
| `src/hooks/useUpdater.tsx` | 检查/下载/安装状态机（自动检查 + 手动触发） |
| `src/components/UpdateModal.tsx` | 更新弹窗（提示/进度/错误） |
| `scripts/build-macos.sh` | 本地打包脚本（配合本流程使用） |
| `scripts/bump-version.mjs` | 三处版本号同步（`pnpm bump`） |
