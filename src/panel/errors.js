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

module.exports = {
  PanelError,
  badRequest,
};
