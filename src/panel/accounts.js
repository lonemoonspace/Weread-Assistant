const fs = require("fs");
const path = require("path");
const { PanelError, badRequest } = require("./errors");
const { normalizeChallenge } = require("./challenge");
const { ACCOUNT_ID_PATTERN, accountDataDir, applyConfigPatch, maskValues } = require("./config");
const { nextRunAt, publicSchedule } = require("./schedules");
const { ensurePrivateDir } = require("../shared/files");

const MAX_NAME_LENGTH = 32;

function normalizeName(rawName, fallback) {
  const name = rawName === undefined || rawName === null ? fallback : String(rawName).trim();
  if (!name) {
    throw badRequest("账号名称不能为空");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw badRequest(`账号名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return name;
}

function findAccount(data, id) {
  const account = data.accounts.find((item) => item.id === id);
  if (!account) {
    throw new PanelError(404, "account_not_found", `账号不存在：${id}`);
  }
  return account;
}

// timezone 为面板设置中的时区，用于计算调度规则接下来的触发时间
function publicAccount(account, panelDataDir, timezone) {
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    createdAt: account.createdAt,
    overrides: maskValues(account.overrides),
    challenge: account.challenge,
    schedules: account.schedules.map((rule) => publicSchedule(rule, timezone)),
    nextRunAt: nextRunAt(account, timezone),
    hasCookies: fs.existsSync(path.join(accountDataDir(panelDataDir, account.id), "cookies.json")),
  };
}

async function createAccount(store, panelDataDir, body) {
  body = body || {};
  const unknown = Object.keys(body).filter((key) => !["id", "name"].includes(key));
  if (unknown.length > 0) {
    throw badRequest(`不支持的字段：${unknown.join(", ")}`);
  }
  const id = String(body.id || "").trim();
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    throw badRequest("账号 ID 只能包含小写字母、数字与短横线，长度 1–32，不能以短横线开头或结尾");
  }
  const name = normalizeName(body.name, id);
  const exists = (data) => {
    if (data.accounts.some((account) => account.id === id)) {
      throw new PanelError(409, "account_exists", `账号已存在：${id}`);
    }
  };

  // 先准备数据目录再写入账号：目录建不出来时接口失败，panel.json 不变，修正后可以重试。
  // 目录可能是之前删除账号时保留下来的，其中的 cookies 会被沿用
  exists(store.get());
  try {
    ensurePrivateDir(accountDataDir(panelDataDir, id));
  } catch (e) {
    throw new PanelError(500, "account_dir_failed", `无法创建账号数据目录，账号未添加：${e.message}`);
  }
  const data = await store.update((draft) => {
    exists(draft);
    draft.accounts.push({
      id,
      name,
      enabled: true,
      createdAt: new Date().toISOString(),
      overrides: {},
      schedules: [],
      challenge: null,
    });
  });
  return findAccount(data, id);
}

// 可修改名称、是否启用、配置覆盖与阅读挑战；账号 ID 创建后不可修改
async function updateAccount(store, id, body = {}) {
  const allowed = new Set(["name", "enabled", "overrides", "challenge"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw badRequest(`不能修改的字段：${unknown.join(", ")}`);
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw badRequest("enabled 必须是 true 或 false");
  }

  const data = await store.update((draft) => {
    const account = findAccount(draft, id);
    if (body.name !== undefined) {
      account.name = normalizeName(body.name);
    }
    if (body.enabled !== undefined) {
      account.enabled = body.enabled;
    }
    if (body.overrides !== undefined) {
      account.overrides = applyConfigPatch(account.overrides, body.overrides);
    }
    if (body.challenge !== undefined) {
      account.challenge = normalizeChallenge(body.challenge);
    }
  });
  return findAccount(data, id);
}

// 默认只从面板移除账号、保留数据目录；deleteData 为 true 时一并删除 cookies、截图与运行记录。
// isBusy(id) 为 true（账号正在运行或排队）时拒绝删除
// 数据目录在写入 panel.json 之前删除：删除失败时账号仍在面板中，可以重试
async function deleteAccount(store, panelDataDir, id, { deleteData = false, isBusy = () => false } = {}) {
  await store.update((draft) => {
    findAccount(draft, id);
    if (isBusy(id)) {
      throw new PanelError(409, "account_busy", `账号正在运行或排队，请先停止：${id}`);
    }
    if (deleteData) {
      removeAccountData(panelDataDir, id);
    }
    draft.accounts = draft.accounts.filter((account) => account.id !== id);
  });
}

function removeAccountData(panelDataDir, id) {
  const root = path.resolve(panelDataDir);
  const dirs = [
    [path.join(root, "accounts"), accountDataDir(panelDataDir, id)],
    [path.join(root, "runs"), path.join(root, "runs", id)],
  ];
  for (const [parent, dir] of dirs) {
    if (path.dirname(dir) !== parent) {
      throw new PanelError(500, "invalid_account_dir", `拒绝删除账号目录之外的路径：${dir}`);
    }
  }
  for (const [, dir] of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      throw new PanelError(500, "delete_data_failed", `删除账号数据失败，账号未移除，可以重试：${e.message}`);
    }
  }
}

module.exports = {
  ACCOUNT_ID_PATTERN,
  createAccount,
  deleteAccount,
  findAccount,
  publicAccount,
  updateAccount,
};
