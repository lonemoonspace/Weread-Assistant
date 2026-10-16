## 前端第三方文件

面板页面免构建，以下文件原样取自 npm 包，不做修改。升级时替换文件并更新本表。

| 文件 | 来源 | 版本 | 许可 | SHA-256 |
| --- | --- | --- | --- | --- |
| `vue.esm-browser.prod.js` | `vue/dist/vue.esm-browser.prod.js` | 3.5.43 | MIT（`LICENSE-vue`） | `877f675a8c5f347073b4d5437439a042b984d81fc5da2770eb7e6d320d5017f3` |
| `pico.min.css` | `@picocss/pico/css/pico.min.css` | 2.1.1 | MIT（`LICENSE-pico.md`） | `fbc9a63fc9fc9f72d12fd7fc9806e11fa9f77ae4f9cad146b27003a1119ba3db` |
| `qrcode.mjs` | `qrcode-generator/dist/qrcode.mjs` | 2.0.4 | MIT（文件头） | `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0` |

Vue 使用包含模板编译器的 ES 模块版本，在浏览器内编译模板，因此面板主页面的 CSP 需要 `'unsafe-eval'`（登录页不需要）。所有模板都写在 `assets/app/` 的脚本中；不要使用 DOM 中的模板，也不要用 `v-html` 渲染服务端或用户提供的内容。
