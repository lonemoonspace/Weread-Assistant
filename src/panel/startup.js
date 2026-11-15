const { normalizeSeleniumUrl } = require("../shared/selenium");
const { passwordLoginState } = require("./http/session");

// 0.1.x 的 docker-compose.yml 经 SELENIUM_URL 把这个地址写入了全局默认配置。新版改用内置浏览器、去掉了 selenium 服务，
// 第一次在没有设置 SELENIUM_URL 的情况下启动时，把全局默认配置与账号配置中的这个地址清空，改用内置浏览器。
// 迁移只做一次（记录在 panel.json 的 migrations 中）：之后在面板中主动填写的同一地址不会再被清空
const LEGACY_SELENIUM_URL = "http://selenium:4444";
const LEGACY_SELENIUM_MIGRATION = "legacy-selenium-url";

async function migrateLegacySeleniumUrl(store) {
  if (store.get().migrations.includes(LEGACY_SELENIUM_MIGRATION)) {
    return;
  }
  const isLegacy = (config) => Boolean(config && config.seleniumUrl) && normalizeSeleniumUrl(config.seleniumUrl) === LEGACY_SELENIUM_URL;
  let cleared = 0;
  await store.update((next) => {
    for (const config of [next.defaults, ...next.accounts.map((account) => account.overrides)]) {
      if (isLegacy(config)) {
        delete config.seleniumUrl;
        cleared += 1;
      }
    }
    next.migrations.push(LEGACY_SELENIUM_MIGRATION);
  });
  if (cleared > 0) {
    console.warn(
      `没有设置 SELENIUM_URL，已把配置中的 Selenium 地址 ${LEGACY_SELENIUM_URL} 清空（${cleared} 处），改用内置浏览器。` +
        "这一步只在升级后执行一次；仍要使用该地址的 Selenium 时在面板设置中重新填写，之后不会再被清空"
    );
  }
}

// 0.4.0 删除了配置项 profileName（实际不起作用），改为按账号保留浏览器资料目录。
// 清除全局默认与账号覆盖中残留的这个字段，只做一次
const DROP_PROFILE_NAME_MIGRATION = "drop-profile-name";

async function dropProfileName(store) {
  if (store.get().migrations.includes(DROP_PROFILE_NAME_MIGRATION)) {
    return;
  }
  await store.update((next) => {
    for (const config of [next.defaults, ...next.accounts.map((account) => account.overrides)]) {
      if (config && Object.hasOwn(config, "profileName")) {
        delete config.profileName;
      }
    }
    next.migrations.push(DROP_PROFILE_NAME_MIGRATION);
  });
}

// 设置中关闭了密码登录、实际仍然允许时提示原因；PANEL_FORCE_PASSWORD_LOGIN 用完后应删掉
function warnPasswordLogin(store, passkeys, forced) {
  const state = passwordLoginState(store, passkeys, forced);
  if (state.reason === "forced") {
    console.warn("PANEL_FORCE_PASSWORD_LOGIN 已生效：密码登录在设置中已关闭，现在临时允许用密码登录。处理完后删掉这个变量并重启面板");
  } else if (state.reason === "no_usable_passkey") {
    console.warn("密码登录在设置中已关闭，但当前域名下没有可用的 passkey，暂时允许用密码登录；用密码登录后重新添加 passkey 即可恢复");
  } else if (forced) {
    console.warn("设置了 PANEL_FORCE_PASSWORD_LOGIN，但密码登录本来就是打开的，可以删掉这个变量");
  }
}

// 已添加的 passkey 在当前地址下都用不了（PANEL_PUBLIC_URL 未设置、不是 HTTPS 或换了域名）时提示，密码登录不受影响
function warnUnusablePasskeys(store, passkeys) {
  const total = store.get().auth.passkeys.length;
  if (total === 0 || passkeys.usableCount() > 0) {
    return;
  }
  console.warn(
    passkeys.available
      ? `已添加的 ${total} 个 passkey 都不是在 ${passkeys.relyingParty.id} 下添加的（更换了域名？），需要用密码登录后重新添加`
      : `已添加了 ${total} 个 passkey，但 PANEL_PUBLIC_URL 没有设置为 HTTPS 地址，暂时不能用 passkey 登录`
  );
}

module.exports = {
  dropProfileName,
  migrateLegacySeleniumUrl,
  warnPasswordLogin,
  warnUnusablePasskeys,
};
