#!/usr/bin/env node
/**
 * 一键同步版本号到三处：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
 *
 * 用法：
 *   pnpm bump 0.2.0     # 指定具体版本
 *   pnpm bump patch     # 0.1.0 -> 0.1.1
 *   pnpm bump minor     # 0.1.0 -> 0.2.0
 *   pnpm bump major     # 0.1.0 -> 1.0.0
 *
 * 发布前先 bump，再推 tag（v<新版本>），CI 会自动构建发布。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];

if (!arg) {
  console.error("用法: pnpm bump <版本号|patch|minor|major>");
  process.exit(1);
}

const pkgPath = path.join(root, "package.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const current = pkg.version;

let next = arg;
if (["patch", "minor", "major"].includes(arg)) {
  const [maj, min, pat] = current.split(".").map(Number);
  next =
    arg === "major"
      ? `${maj + 1}.0.0`
      : arg === "minor"
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`;
}

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`非法版本号: ${next}（需要 x.y.z 或 patch|minor|major）`);
  process.exit(1);
}

pkg.version = next;
conf.version = next;
const cargo = readFileSync(cargoPath, "utf8").replace(
  /^version = ".*"$/m,
  `version = "${next}"`,
);

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
writeFileSync(cargoPath, cargo);

console.log(`版本 ${current} → ${next}（package.json / Cargo.toml / tauri.conf.json 已同步）`);
