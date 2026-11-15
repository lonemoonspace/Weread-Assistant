#!/usr/bin/env node
// 发布流程（.github/workflows/image.yml）读取已发布镜像的版本号，判断能否改动 latest：
//   docker buildx imagetools inspect IMAGE:latest --format '{{json .Image}}' | node scripts/image-version.js version
//     打印标签 org.opencontainers.image.version；读不到时不打印。.Image 对单架构镜像是镜像配置本身，
//     对多架构清单是“平台 → 镜像配置”的对象，也可能是 null
//   docker buildx imagetools inspect IMAGE:latest --raw | node scripts/image-version.js child
//     从多架构清单中取第一个真正平台（跳过 unknown/unknown 的构建证明）的摘要，单独读取它的版本
//   node scripts/image-version.js compare <当前> <本次>
//     打印 newer（当前比本次新）、same、older 或 unknown（任一个不是 x.y.z）
"use strict";

const VERSION_LABEL = "org.opencontainers.image.version";

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function labelsOf(image) {
  const labels = image && typeof image === "object" && image.config && image.config.Labels;
  return labels && typeof labels === "object" ? labels : null;
}

function versionFromImage(text) {
  const value = parse(text);
  if (!value || typeof value !== "object") return "";
  const own = labelsOf(value);
  const candidates = own ? [own] : Object.values(value).map(labelsOf).filter(Boolean);
  for (const labels of candidates) {
    const version = labels[VERSION_LABEL];
    if (typeof version === "string" && version.trim()) return version.trim();
  }
  return "";
}

function childDigest(text) {
  const value = parse(text);
  const manifests = value && Array.isArray(value.manifests) ? value.manifests : [];
  const entry = manifests.find(
    (item) =>
      item &&
      typeof item.digest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(item.digest) &&
      item.platform &&
      item.platform.os &&
      item.platform.os !== "unknown"
  );
  return entry ? entry.digest : "";
}

function compareVersions(current, next) {
  const parts = (text) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || "").trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parts(current);
  const b = parts(next);
  if (!a || !b) return "unknown";
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? "newer" : "older";
  }
  return "same";
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "compare") {
    console.log(compareVersions(rest[0], rest[1]));
    return 0;
  }
  if (command === "version" || command === "child") {
    const text = await readStdin();
    const result = command === "version" ? versionFromImage(text) : childDigest(text);
    if (result) console.log(result);
    return 0;
  }
  console.error("用法：image-version.js version|child（从标准输入读取）或 compare <当前> <本次>");
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { childDigest, compareVersions, versionFromImage };
