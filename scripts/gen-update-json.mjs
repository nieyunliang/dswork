#!/usr/bin/env node
/**
 * 生成 updater 更新清单 latest.json（macOS 双架构）
 *
 * 用法：
 *   node scripts/gen-update-json.mjs            # 版本取 package.json，双架构产物必须存在
 *   node scripts/gen-update-json.mjs 0.1.3      # 指定版本
 *
 * 产物：
 *   latest.json（上传到 GitHub Release 根目录，app 从
 *   https://github.com/nieyunliang/dswork/releases/latest/download/latest.json 检测更新）
 *
 * 前置：已用 scripts/build-macos.sh --both 带签名构建，
 *       src-tauri/target/<arch>-apple-darwin/release/bundle/macos/ 下有
 *       dswork.app.tar.gz 与 dswork.app.tar.gz.sig。
 *
 * 上传资产命名约定（GitHub 资产名不能重名，双架构必须区分）：
 *   dswork-aarch64.app.tar.gz + dswork-aarch64.app.tar.gz.sig
 *   dswork-x86_64.app.tar.gz  + dswork-x86_64.app.tar.gz.sig
 *   latest.json
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = "nieyunliang/dswork";

const version = process.argv[2] ?? JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`非法版本号: ${version}`);
  process.exit(1);
}

const ARCHES = [
  { key: "darwin-aarch64", target: "aarch64-apple-darwin", asset: "dswork-aarch64.app.tar.gz" },
  { key: "darwin-x86_64", target: "x86_64-apple-darwin", asset: "dswork-x86_64.app.tar.gz" },
];

const platforms = {};
for (const { key, target, asset } of ARCHES) {
  const bundleDir = path.join(
    root, "src-tauri", "target", target, "release", "bundle", "macos",
  );
  const tarball = path.join(bundleDir, "dswork.app.tar.gz");
  const sigFile = path.join(bundleDir, "dswork.app.tar.gz.sig");
  if (!fsExists(tarball) || !fsExists(sigFile)) {
    console.error(`缺少 ${target} 的 updater 产物: ${tarball} 或 ${sigFile}`);
    console.error("请先带签名构建（scripts/build-macos.sh --both）");
    process.exit(1);
  }
  platforms[key] = {
    signature: readFileSync(sigFile, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${asset}`,
  };
}

const manifest = {
  version,
  notes: "",
  pub_date: new Date().toISOString(),
  platforms,
};

const out = path.join(root, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`✅ 已生成 ${out}`);
console.log("");
console.log("上传到 GitHub Release v" + version + " 的资产清单（共 5 个）:");
for (const { target, asset } of ARCHES) {
  const bundleDir = path.join(root, "src-tauri", "target", target, "release", "bundle", "macos");
  const tarball = path.join(bundleDir, "dswork.app.tar.gz");
  const sigFile = path.join(bundleDir, "dswork.app.tar.gz.sig");
  console.log(`  - ${asset}            （来自 ${tarball}）`);
  console.log(`  - ${asset}.sig        （来自 ${sigFile}）`);
}
console.log("  - latest.json         （本次生成的更新清单）");
console.log("");
console.log(`上传后端点生效: https://github.com/${repo}/releases/latest/download/latest.json`);

function fsExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
