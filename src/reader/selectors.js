// 页面地址、定位器与关键文案集中在这里，微信读书改版时只需要改这个文件。
// XPath 以字符串保存，既用于 WebDriver 定位，也传给页面脚本一次性检查页面状态。
const WEREAD_HOME_URL = "https://weread.qq.com/";
const HOME_TITLE = "微信读书";
const TITLE_SUFFIX = " - 微信读书";

const XPATH = {
  loginLink: "//a[contains(text(), '登录')]",
  shelfLink: "//div[contains(text(), '我的书架') and @class='wr_index_page_top_section_header_action_link']",
  // 只在登录弹窗中查找：首页书籍封面的图片地址（wfqqreader-*.myqcloud.com）也含有“qr”
  qrImage:
    "//img[contains(@class, 'wr_login_modal_qr_img') or " +
    "(ancestor::*[contains(@class, 'wr_login_modal')] and (contains(@class, 'qr') or contains(@alt, '二维码')))]",
  // 弹窗中的提示文字（“使用微信扫一扫登录”），二维码图片还没加载出来时据此判断弹窗已打开
  qrHint:
    "//*[contains(@class, 'wr_login_modal')]//*[contains(text(), '扫一扫') or contains(text(), '扫码') or contains(text(), '二维码')]",
  qrExpiredOverlay: "//div[contains(text(), '点击刷新二维码') and @class='wr_login_modal_qr_overlay_text']",
  qrExpiredText: "//*[contains(text(), '二维码已失效')]",
  // 书架加载完成前首页先显示 4 个不含链接的占位卡片，点击无效；公众号文章打开的是另一种阅读页，没有目录按钮
  shelfBookLink: "//div[@class='wr_index_mini_shelf_card']/a[@href!='' and not(contains(@href, '/mp/reader'))]",
  catalogButton: '//button[@title="目录"]',
  verticalModeButton: "//button[@title='切换到上下滚动阅读'] | //button[contains(@class, 'readerControls_item') and contains(@class, 'isHorizontalReader')]",
  catalogItem: "//li[@class='readerCatalog_list_item']",
  unlockPrompt: "//span[contains(text(), '开通后即可阅读')]",
  bookFinished: "//div[contains(text(), '全 书 完')]",
  nextButton: "//button[@title='下一章'] | //button[@title='下一页']",
  retryButton: "//div[contains(text(), '点击重试')]",
};

// 二维码过期后的刷新入口，按顺序尝试
const QR_REFRESH_LOCATORS = [
  { css: ".login_dialog_retry_delegate" },
  { xpath: "//div[contains(@class, 'login_dialog_retry_delegate')]" },
  { xpath: XPATH.qrExpiredOverlay },
  { xpath: "//div[contains(text(), '点击刷新二维码')]" },
  { xpath: "//div[contains(@class, 'refresh') or contains(@class, 'retry')]" },
  { xpath: "//button[contains(text(), '刷新')]" },
  { xpath: "//span[contains(text(), '刷新')]" },
];
const QR_REFRESH_SCRIPT =
  "const delegate = document.querySelector('.login_dialog_retry_delegate'); if (delegate) { delegate.click(); return true; } return false;";

// 阅读页标题为“书名 - 作者 - 微信读书”，读完时标题包含“已读完”
const READ_FINISHED_TITLE_TEXT = "已读完";

function parseBookTitle(pageTitle) {
  const title = String(pageTitle || "");
  if (!title.endsWith(TITLE_SUFFIX)) {
    return "";
  }
  return title.slice(0, -TITLE_SUFFIX.length).split(" - ")[0].trim();
}

module.exports = {
  HOME_TITLE,
  QR_REFRESH_LOCATORS,
  QR_REFRESH_SCRIPT,
  READ_FINISHED_TITLE_TEXT,
  WEREAD_HOME_URL,
  XPATH,
  parseBookTitle,
};
