// 外观：跟随系统、浅色或深色。在页面渲染前（同步脚本，放在 <head> 中）按保存的选择设置 data-theme，避免闪烁；
// 跟随系统时不设置，由样式表中的 prefers-color-scheme 决定
(function () {
  try {
    var theme = localStorage.getItem("wa-theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    }
  } catch (_) {
    // 浏览器禁止访问 localStorage 时跟随系统
  }
})();
