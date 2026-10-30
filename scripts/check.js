#!/usr/bin/env node
/**
 * 仓库自查：CI 中最先运行，不需要浏览器与 Docker。
 * - 语法：src/ 与 scripts/ 下的脚本按 CommonJS 检查；面板页面的 ES 模块（assets/app/，以及页面以 type="module" 引用的脚本）按模块检查。
 *   node --check 检查没有声明为模块的 .js 文件时，遇到 import 语句会直接跳过而不报错，因此经标准输入以模块方式检查
 * - 面板第三方文件（assets/vendor/）与其中 README 记录的 SHA-256 一致，且每个文件都有记录
 * - 面板页面没有内联脚本、内联样式与内联事件处理；模板中不使用 v-html 与样式绑定
 * - 面板 HTML 中引用的同源脚本与样式都存在
 * 用法: node scripts/check.js
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "src", "panel", "public");
const APP_DIR = path.join(PUBLIC_DIR, "assets", "app");
const VENDOR_DIR = path.join(PUBLIC_DIR, "assets", "vendor");

const relative = (file) => path.relative(ROOT, file);

function listFiles(dir, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full, predicate));
    } else if (predicate(full)) {
      files.push(full);
    }
  }
  return files.sort();
}

// 标签中某个属性的值：双引号、单引号或不带引号都可以，大小写不敏感；没有这个属性时为 null
function tagAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>\`]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]).trim() : null;
}

// 页面以 type="module" 引用的脚本，例如登录页的 assets/login.js。属性的顺序与引号不限，地址中的查询参数与片段忽略
function pageModules() {
  const files = new Set();
  for (const page of listFiles(PUBLIC_DIR, (file) => file.endsWith(".html"))) {
    for (const [tag] of fs.readFileSync(page, "utf8").matchAll(/<script\b[^>]*>/gi)) {
      const src = tagAttribute(tag, "src");
      if (src && (tagAttribute(tag, "type") || "").toLowerCase() === "module") {
        files.add(path.join(path.dirname(page), src.replace(/[?#].*$/, "")));
      }
    }
  }
  return files;
}

function checkSyntax() {
  const problems = [];
  const modules = pageModules();
  const scripts = [
    ...listFiles(path.join(ROOT, "src"), (file) => file.endsWith(".js") && !file.startsWith(VENDOR_DIR + path.sep)),
    ...listFiles(path.join(ROOT, "scripts"), (file) => file.endsWith(".js")),
  ];
  for (const file of scripts) {
    const isModule = file.startsWith(APP_DIR + path.sep) || modules.has(file);
    const result = isModule
      ? spawnSync(process.execPath, ["--input-type=module", "--check"], { input: fs.readFileSync(file), encoding: "utf8" })
      : spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      problems.push(`${relative(file)}：\n${(result.stderr || "").trim()}`);
    }
  }
  return { count: scripts.length, problems };
}

function checkVendor() {
  const problems = [];
  const readme = fs.readFileSync(path.join(VENDOR_DIR, "README.md"), "utf8");
  const recorded = new Map();
  for (const match of readme.matchAll(/^\| `([^`]+)` \|.*\| `([0-9a-f]{64})` \|$/gm)) {
    recorded.set(match[1], match[2]);
  }
  const files = fs
    .readdirSync(VENDOR_DIR)
    .filter((name) => name !== "README.md" && !name.startsWith("LICENSE"));
  for (const name of files) {
    if (!recorded.has(name)) {
      problems.push(`assets/vendor/${name} 没有记录在 README.md 中`);
      continue;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(VENDOR_DIR, name))).digest("hex");
    if (actual !== recorded.get(name)) {
      problems.push(`assets/vendor/${name} 的 SHA-256 为 ${actual}，与 README.md 中记录的 ${recorded.get(name)} 不一致`);
    }
  }
  for (const name of recorded.keys()) {
    if (!files.includes(name)) {
      problems.push(`README.md 中记录的 assets/vendor/${name} 不存在`);
    }
  }
  return { count: files.length, problems };
}

// 内联脚本、内联样式与内联事件处理会被 CSP 拦截；v-html 与样式绑定违反页面约定（见 AGENTS.md）
function checkPages() {
  const problems = [];
  const pages = listFiles(PUBLIC_DIR, (file) => file.endsWith(".html"));
  for (const file of pages) {
    const html = fs.readFileSync(file, "utf8");
    const rules = [
      [/<script(?![^>]*\bsrc=)[^>]*>/i, "内联脚本"],
      [/<style\b/i, "内联样式表"],
      [/\sstyle\s*=/i, "style 属性"],
      [/\son[a-z]+\s*=/i, "内联事件处理"],
    ];
    for (const [pattern, label] of rules) {
      if (pattern.test(html)) {
        problems.push(`${relative(file)} 中有${label}`);
      }
    }
    // 引用的同源资源应存在（相对于页面所在目录）
    for (const match of html.matchAll(/\s(?:src|href)="([^"#?:]+\.(?:js|mjs|css))"/g)) {
      if (!fs.existsSync(path.join(path.dirname(file), match[1]))) {
        problems.push(`${relative(file)} 引用的 ${match[1]} 不存在`);
      }
    }
  }
  const templates = listFiles(APP_DIR, (file) => file.endsWith(".js"));
  for (const file of templates) {
    const source = fs.readFileSync(file, "utf8");
    const rules = [
      [/\bv-html\b/, "v-html"],
      [/(?:\s:style|v-bind:style)\s*=/, "样式绑定（:style）"],
      [/\sstyle\s*=\s*["']/, "style 属性"],
      [/\son[a-z]+\s*=\s*["']/, "内联事件处理"],
    ];
    for (const [pattern, label] of rules) {
      if (pattern.test(source)) {
        problems.push(`${relative(file)} 的模板中有${label}`);
      }
    }
  }
  return { count: pages.length + templates.length, problems };
}

function main() {
  let failed = false;
  const report = (title, { count, problems }) => {
    if (problems.length) {
      failed = true;
      console.error(`❌ ${title}（${count} 个文件）`);
      for (const problem of problems) {
        console.error(`   ${problem.replace(/\n/g, "\n   ")}`);
      }
    } else {
      console.log(`✅ ${title}（${count} 个文件）`);
    }
  };
  report("语法检查：脚本按 CommonJS、面板页面按 ES 模块", checkSyntax());
  report("面板第三方文件与 README 中的 SHA-256 一致", checkVendor());
  report("面板页面没有内联脚本、样式与事件处理，模板不使用 v-html 与样式绑定，引用的文件存在", checkPages());
  if (failed) {
    console.error("\n自查未通过");
    process.exit(1);
  }
  console.log("\n自查全部通过");
}

main();
