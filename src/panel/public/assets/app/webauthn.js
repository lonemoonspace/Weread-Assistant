// passkey（WebAuthn）在浏览器中的调用：把服务端返回的 JSON 参数转换为 navigator.credentials 的参数，
// 再把结果转回 JSON 交给服务端校验。登录页与设置页共用，不依赖 Vue

function toBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer;
}

function toBase64url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const withBufferIds = (list) => (list || []).map((item) => ({ ...item, id: toBuffer(item.id) }));

// 浏览器支持 passkey，且页面是安全上下文（HTTPS 或 localhost）
export function passkeySupported() {
  return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
}

// passkey 只能在服务端配置的地址（origin）上使用，例如用内网 IP 打开面板时不能用
export function originMatches(passkey) {
  return Boolean(passkey && passkey.available && passkey.origin === location.origin);
}

function credentialBase(credential) {
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
  };
}

// 添加 passkey：options 为服务端返回的参数，返回交给服务端校验的结果
export async function createPasskey(options) {
  const publicKey = {
    ...options,
    challenge: toBuffer(options.challenge),
    user: { ...options.user, id: toBuffer(options.user.id) },
    excludeCredentials: withBufferIds(options.excludeCredentials),
  };
  const credential = await navigator.credentials.create({ publicKey });
  const { response } = credential;
  return {
    ...credentialBase(credential),
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
  };
}

// 用 passkey 登录或二次验证：options 为服务端返回的参数，返回交给服务端校验的结果
export async function getPasskey(options) {
  const publicKey = { ...options, challenge: toBuffer(options.challenge), allowCredentials: withBufferIds(options.allowCredentials) };
  const credential = await navigator.credentials.get({ publicKey });
  const { response } = credential;
  return {
    ...credentialBase(credential),
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      userHandle: response.userHandle ? toBase64url(response.userHandle) : undefined,
    },
  };
}

// 浏览器在调用 passkey 时抛出的错误转为提示文字；用户取消返回空字符串
export function passkeyErrorMessage(error) {
  switch (error && error.name) {
    case "NotAllowedError":
    case "AbortError":
      return "";
    case "InvalidStateError":
      return "这个设备上已经有该面板的 passkey 了";
    case "SecurityError":
      return "当前地址不能使用 passkey";
    case "NotSupportedError":
      return "这个设备不支持 passkey";
    default:
      return (error && error.message) || "passkey 调用失败";
  }
}
