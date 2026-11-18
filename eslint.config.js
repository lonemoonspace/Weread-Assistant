// ESLint 配置（npm run lint）：推荐规则集。后端与脚本按 CommonJS 检查，面板页面按浏览器中的 ES 模块检查，
// assets/vendor/ 下的第三方文件不检查
const js = require("@eslint/js");
const globals = require("globals");

const PANEL_ASSETS = "src/panel/public/assets";

module.exports = [
  { ignores: [`${PANEL_ASSETS}/vendor/**`, "node_modules/**", "data/**", "chromedriver/**"] },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // catch (_) 与 catch (e) 不使用错误对象是常见写法；以下划线开头的参数表示有意不使用；
      // 用剩余属性去掉某些字段（const { a, ...rest } = obj）时 a 不算未使用
      "no-unused-vars": ["error", { caughtErrors: "none", argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      // 空的 catch 块用于“失败时忽略”，其余空块仍然报错
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: globals.node },
  },
  {
    files: [`${PANEL_ASSETS}/app/**/*.js`, `${PANEL_ASSETS}/login.js`],
    languageOptions: { sourceType: "module", globals: { ...globals.browser, api: "readonly" } },
  },
  {
    // 普通脚本，定义 api() 供登录页使用
    files: [`${PANEL_ASSETS}/api.js`],
    languageOptions: { sourceType: "script", globals: globals.browser },
    rules: { "no-unused-vars": ["error", { caughtErrors: "none", varsIgnorePattern: "^api$" }] },
  },
  {
    // 普通脚本，在页面渲染前设置外观
    files: [`${PANEL_ASSETS}/theme.js`],
    languageOptions: { sourceType: "script", globals: globals.browser },
  },
];
