/**
 * 测试用的软件认证器：按 WebAuthn 规范生成添加 passkey（attestation 为 none）与登录（assertion）的结果，
 * 格式与浏览器 PublicKeyCredential 转成的 JSON 相同。使用 ES256（P-256）密钥。
 * 每个结果都可以按参数篡改（origin、RP ID、标志位、计数器、challenge、签名），用于校验失败的场景。
 */

const crypto = require("crypto");

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();

// 只实现测试需要的 CBOR 编码：无符号与负整数、字节串、文本串、数组、映射
function cborHead(major, value) {
  if (value < 24) {
    return Buffer.from([(major << 5) | value]);
  }
  if (value < 0x100) {
    return Buffer.from([(major << 5) | 24, value]);
  }
  if (value < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(value, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(value, 1);
  return head;
}

function cbor(value) {
  if (Number.isInteger(value)) {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([cborHead(2, value.length), value]);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
  }
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [key, item] of value) {
      parts.push(cbor(key), cbor(item));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`不支持的 CBOR 值：${value}`);
}

function createSoftAuthenticator({ rpId, origin, backedUp = true } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = crypto.randomBytes(16);
  let counter = 0;
  let userHandle = "";

  const coseKey = cbor(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ])
  );

  function authenticatorData({ rpId: dataRpId = rpId, flags, signCount, attested }) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(signCount, 0);
    const parts = [sha256(dataRpId), Buffer.from([flags]), count];
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length, 0);
      parts.push(Buffer.alloc(16), length, credentialId, coseKey);
    }
    return Buffer.concat(parts);
  }

  const clientData = ({ type, challenge, origin: dataOrigin = origin }) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: dataOrigin, crossOrigin: false }));

  const defaultFlags = FLAG_UP | FLAG_UV | (backedUp ? FLAG_BE | FLAG_BS : 0);

  return {
    id: b64url(credentialId),

    // options：服务端返回的添加参数（PublicKeyCredentialCreationOptionsJSON）；tamper 中的字段覆盖正常值
    register(options, tamper = {}) {
      userHandle = options.user ? options.user.id : "";
      const authData = authenticatorData({
        rpId: tamper.rpId,
        flags: (tamper.flags === undefined ? defaultFlags : tamper.flags) | FLAG_AT,
        signCount: 0,
        attested: true,
      });
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientData({ type: "webauthn.create", challenge: tamper.challenge || options.challenge, origin: tamper.origin })),
          attestationObject: b64url(attestationObject),
          transports: ["internal", "hybrid"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },

    // options：服务端返回的登录参数（PublicKeyCredentialRequestOptionsJSON）。每次调用计数器加一（tamper.counter 可指定）
    assert(options, tamper = {}) {
      counter = tamper.counter === undefined ? counter + 1 : tamper.counter;
      const authData = authenticatorData({
        rpId: tamper.rpId,
        flags: tamper.flags === undefined ? defaultFlags : tamper.flags,
        signCount: counter,
        attested: false,
      });
      const clientDataJSON = clientData({ type: tamper.type || "webauthn.get", challenge: tamper.challenge || options.challenge, origin: tamper.origin });
      const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      if (tamper.badSignature) {
        signature[signature.length - 1] ^= 0xff;
      }
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
          userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}

module.exports = {
  FLAG_UP,
  FLAG_UV,
  createSoftAuthenticator,
};
