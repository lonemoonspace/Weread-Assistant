const { By, until } = require("selenium-webdriver");

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
  } catch (_) {
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
    } catch (_) {}
  }
  return null;
}

// 等到出现可见的匹配元素并返回它；超时返回 null
async function waitForVisible(driver, xpath, timeoutMs) {
  try {
    return await driver.wait(() => findVisible(driver, xpath), timeoutMs);
  } catch (_) {
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
  findElementsWithin,
  findVisible,
  randomBetween,
  sleep,
  throwIfStopped,
  toBy,
  waitForAnyXpath,
  waitForVisible,
  xpathsExist,
};
