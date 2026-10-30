const { By, until, error: webdriverErrors } = require("selenium-webdriver");

// 隐式等待为 0，元素不存在时 findElements 立即返回；需要等元素出现的地方都用这里的显式等待

const EXISTS_SCRIPT = `
  return arguments[0].map((xpath) =>
    !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
  );
`;

// 运行被停止（面板中点击停止，或进程收到 SIGTERM / SIGINT）
class RunStoppedError extends Error {
  constructor() {
    super("运行已停止");
    this.name = "RunStoppedError";
  }
}

function throwIfStopped(signal) {
  if (signal && signal.aborted) {
    throw new RunStoppedError();
  }
}

// 传入 signal 时，停止后立即结束等待并抛出 RunStoppedError
function sleep(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunStoppedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunStoppedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 会话已经不存在或连不上浏览器：重试与等待都没有意义，需要原样抛出，不能当作“元素没找到”
function isSessionLost(e) {
  return (
    e instanceof webdriverErrors.NoSuchSessionError ||
    /ECONNREFUSED|ECONNRESET|socket hang up/i.test(String(e && e.message))
  );
}

// 点击元素；直接点击失败（被遮挡、不可交互等）时依次改用脚本点击与 Actions 点击，返回是否点击成功。
// 会话已断开时直接抛出
async function safeClickElement(driver, element, description = "元素") {
  const attempts = [
    ["直接点击", async () => {
      if (!(await element.isDisplayed())) {
        console.warn(`${description}不可见，尝试滚动到元素位置`);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
        await sleep(500);
      }
      await element.click();
    }],
    ["使用JavaScript点击", () => driver.executeScript("arguments[0].click();", element)],
    ["使用Actions类点击", () => driver.actions({ bridge: true }).move({ origin: element }).click().perform()],
  ];
  for (const [method, click] of attempts) {
    try {
      await click();
      console.info(`${method}${description}成功`);
      return true;
    } catch (e) {
      if (isSessionLost(e)) {
        throw e;
      }
      console.warn(`${method}${description}失败: ${e.message}`);
    }
  }
  console.error(`所有点击方法都失败: ${description}`);
  return false;
}

// 同 safeClickElement，都失败时抛出错误
async function clickOrThrow(driver, element, description) {
  if (!(await safeClickElement(driver, element, description))) {
    throw new Error(`无法点击${description}`);
  }
}

function toBy(locator) {
  return locator.css ? By.css(locator.css) : By.xpath(locator.xpath);
}

// 一次往返检查多个 XPath 是否存在，返回与输入顺序一致的布尔数组
async function xpathsExist(driver, xpaths) {
  return driver.executeScript(EXISTS_SCRIPT, xpaths);
}

// 等元素出现后返回全部匹配；超时返回空数组
async function findElementsWithin(driver, xpath, timeoutMs) {
  try {
    await driver.wait(until.elementLocated(By.xpath(xpath)), timeoutMs);
  } catch (e) {
    if (isSessionLost(e)) {
      throw e;
    }
    return [];
  }
  return driver.findElements(By.xpath(xpath));
}

// 第一个可见的匹配元素；没有时返回 null。元素在检查过程中被移除时视为不可见
async function findVisible(driver, xpath) {
  for (const element of await driver.findElements(By.xpath(xpath))) {
    try {
      if (await element.isDisplayed()) {
        return element;
      }
    } catch (e) {
      if (isSessionLost(e)) {
        throw e;
      }
    }
  }
  return null;
}

// 等到出现可见的匹配元素并返回它；超时返回 null
async function waitForVisible(driver, xpath, timeoutMs) {
  try {
    return await driver.wait(() => findVisible(driver, xpath), timeoutMs);
  } catch (e) {
    if (isSessionLost(e)) {
      throw e;
    }
    return null;
  }
}

// 轮询直到某个 XPath 出现，返回第一个出现的下标；超时返回 -1
async function waitForAnyXpath(driver, xpaths, timeoutMs, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await xpathsExist(driver, xpaths)).indexOf(true);
    if (found !== -1 || Date.now() >= deadline) {
      return found;
    }
    await sleep(pollMs);
  }
}

module.exports = {
  RunStoppedError,
  clickOrThrow,
  findElementsWithin,
  findVisible,
  isSessionLost,
  randomBetween,
  safeClickElement,
  sleep,
  throwIfStopped,
  toBy,
  waitForAnyXpath,
  waitForVisible,
  xpathsExist,
};
