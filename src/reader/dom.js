const { By, until } = require("selenium-webdriver");

// 隐式等待为 0，元素不存在时 findElements 立即返回；需要等元素出现的地方都用这里的显式等待

const EXISTS_SCRIPT = `
  return arguments[0].map((xpath) =>
    !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
  );
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  findElementsWithin,
  randomBetween,
  sleep,
  toBy,
  waitForAnyXpath,
  xpathsExist,
};
