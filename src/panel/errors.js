// 面板接口中可以直接返回给调用方的错误：status 为 HTTP 状态码，code 供前端判断，message 给人看
class PanelError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function badRequest(message, code = "invalid_request") {
  return new PanelError(400, code, message);
}

// 控制字符（含换行）、行与段落分隔符、文字方向控制符：账号与 passkey 的名称会写入日志、推送标题并显示在页面上，
// 这些字符会伪造日志行或打乱显示
const UNSAFE_NAME_CHARS = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

// 名称中有上述字符时抛出 400；what 为提示中的名称种类，例如“账号名称”
function rejectUnsafeName(name, what) {
  if (UNSAFE_NAME_CHARS.test(name)) {
    throw badRequest(`${what}不能包含换行、控制字符或文字方向控制符`);
  }
}

module.exports = {
  PanelError,
  badRequest,
  rejectUnsafeName,
};
