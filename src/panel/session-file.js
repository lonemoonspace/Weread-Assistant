const fs = require("fs");
const { writeFileAtomic } = require("../shared/files");

// 会话持久化文件 data/sessions.json（0600）：面板重启后已登录的设备不必重新登录。
// 只保存令牌的 SHA-256 哈希与会话的时间、登录方式，拿到文件也得不到可用的 cookie。
// 结构：{ version, salt, fingerprint, sessions: [{ key, createdAt, expiresAt, cookieSetAt, method, credentialId, keepWithoutPasswordLogin? }] }，
// keepWithoutPasswordLogin 为关闭密码登录时保留下来的那个密码会话
// fingerprint 为当时面板密码的指纹（见 auth.js），启动时密码变了就不恢复用密码登录的会话
const FILE_VERSION = 1;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const METHODS = new Set(["password", "passkey"]);

function isTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validSession(item) {
  return (
    item &&
    typeof item === "object" &&
    KEY_PATTERN.test(item.key) &&
    isTime(item.createdAt) &&
    isTime(item.expiresAt) &&
    isTime(item.cookieSetAt) &&
    METHODS.has(item.method) &&
    typeof item.credentialId === "string" &&
    item.credentialId.length <= 1024 &&
    (item.keepWithoutPasswordLogin === undefined || typeof item.keepWithoutPasswordLogin === "boolean")
  );
}

// 读取文件。不存在时返回 null；损坏时写一条警告并返回 null（当作没有保存的会话），不影响启动
function readSessionFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.warn(`读取 ${file} 失败，已登录的设备需要重新登录：${e.message}`);
    }
    return null;
  }
  // 从备份还原或被改过权限的文件收紧为 0600（与 panel.json 相同）
  try {
    fs.chmodSync(file, 0o600);
  } catch (e) {
    console.warn(`无法把 ${file} 的权限改为 0600：${e.message}`);
  }
  try {
    const data = JSON.parse(text);
    if (!data || data.version !== FILE_VERSION || typeof data.salt !== "string" || !Array.isArray(data.sessions)) {
      throw new Error("结构不对");
    }
    return {
      salt: data.salt,
      fingerprint: typeof data.fingerprint === "string" ? data.fingerprint : "",
      sessions: data.sessions.filter(validSession),
    };
  } catch (e) {
    console.warn(`${file} 已损坏（${e.message}），当作没有保存的会话，已登录的设备需要重新登录`);
    return null;
  }
}

// 写入文件；失败（例如数据目录只读）时抛出错误，由调用者决定是否改为只在内存中保存
function writeSessionFile(file, { salt, fingerprint, sessions }) {
  const data = { version: FILE_VERSION, salt, fingerprint, sessions };
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

module.exports = {
  readSessionFile,
  writeSessionFile,
};
