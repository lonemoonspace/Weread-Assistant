const express = require("express");
const { VERSION } = require("../../../shared/version");
const { MIN_PASSWORD_LENGTH } = require("../../auth");
const { PanelError, badRequest, requireObject } = require("../../errors");
const { passwordLoginState, reauthRequired, requireRecentAuth, sendAuthFailure } = require("../session");

// 两组接口共用的视图
function authViews({ options, store, passkeys }) {
  return {
    // passkey 是否可用，以及可用时面板的地址（origin）：页面不在这个地址打开时不能使用 passkey
    passkeyView: () => (passkeys.available ? { available: true, origin: passkeys.relyingParty.origin } : { available: false }),
    passwordLogin: () => passwordLoginState(store, passkeys, options.forcePasswordLogin),
    passwordLoginDisabled: (res, status) =>
      res.status(status).json({ error: "password_login_disabled", message: "密码登录已关闭，请用 passkey 登录" }),
  };
}

// 不需要登录的接口：密码与 passkey 登录、可用的登录方式
function publicAuthRoutes(ctx) {
  const { auth, passkeys, cookies } = ctx;
  const { passkeyView, passwordLogin, passwordLoginDisabled } = authViews(ctx);
  const router = express.Router();

  // 密码登录关闭时直接拒绝，不校验密码，也不计入限速
  router.post("/auth/login", async (req, res) => {
    if (!passwordLogin().active) {
      passwordLoginDisabled(res, 403);
      return;
    }
    const result = await auth.login(req.ip, req.body && req.body.password);
    if (result.ok) {
      cookies.setSessionCookie(req, res, result.token);
      console.info("面板登录成功:", req.ip);
      res.status(204).end();
      return;
    }
    if (!result.locked) {
      console.warn("面板登录失败:", req.ip);
    }
    sendAuthFailure(res, result, 401, "wrong_password");
  });

  // 登录页据此决定显示哪些登录方式：是否允许密码登录、是否提供 passkey 与它所在的地址，不透露添加了哪些 passkey
  router.get("/auth/methods", (req, res) => {
    res.json({ password: passwordLogin().active, passkey: passkeyView() });
  });

  // { purpose: "login" | "reauth" }：passkey 登录或二次验证的参数。登录不需要会话，被限速时 429；二次验证需要已登录
  router.post("/auth/passkey/options", async (req, res) => {
    const purpose = req.body && req.body.purpose;
    if (purpose === "reauth") {
      if (!req.sessionToken) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      res.json(await passkeys.reauthOptions(req.sessionToken));
      return;
    }
    if (purpose !== "login") {
      throw badRequest("purpose 只能是 login 或 reauth");
    }
    const wait = auth.passkeyRetryAfterMs(req.ip);
    if (wait > 0) {
      sendAuthFailure(res, { locked: true, retryAfterMs: wait });
      return;
    }
    res.json(await passkeys.loginOptions());
  });

  let unknownPasskeyLoggedAt = 0;
  // { response }：浏览器返回的 passkey 登录结果。成功 204 并下发会话 cookie，失败 401（计入限速）。
  // 不是已添加的 passkey 时同样 401，但不计入限速
  router.post("/auth/passkey/login", async (req, res) => {
    const response = req.body && req.body.response;
    if (!passkeys.isKnownCredential(response)) {
      const wait = auth.passkeyRetryAfterMs(req.ip);
      if (wait > 0) {
        sendAuthFailure(res, { locked: true, retryAfterMs: wait });
        return;
      }
      // 这类请求不限速，日志每分钟最多记一条，避免被刷满磁盘
      if (Date.now() - unknownPasskeyLoggedAt >= 60 * 1000) {
        unknownPasskeyLoggedAt = Date.now();
        console.warn("面板 passkey 登录失败（不是当前域名下已添加的 passkey，1 分钟内不再记录同类失败）:", req.ip);
      }
      res.status(401).json({ error: "passkey_failed" });
      return;
    }
    const result = await auth.loginWithPasskey(req.ip, () => passkeys.verifyLogin(response));
    if (result.ok) {
      cookies.setSessionCookie(req, res, result.token);
      console.info(`面板登录成功（passkey「${result.passkey.name}」）:`, req.ip);
      res.status(204).end();
      return;
    }
    if (!result.locked) {
      console.warn("面板 passkey 登录失败:", req.ip);
    }
    sendAuthFailure(res, result, 401, "passkey_failed");
  });

  return router;
}

// 需要登录的接口：会话信息、二次验证、passkey 管理、密码登录开关、退出登录、修改密码
function authRoutes(ctx) {
  const { auth, store, passkeys, cookies } = ctx;
  const { passkeyView, passwordLogin, passwordLoginDisabled } = authViews(ctx);
  const recentAuth = requireRecentAuth(auth);
  const router = express.Router();

  router.get("/auth/session", (req, res) => {
    res.json({
      authenticated: true,
      version: VERSION,
      passwordFromEnv: auth.passwordFromEnv,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      passkey: passkeyView(),
      passwordLogin: passwordLogin(),
      otherSessions: auth.otherSessionCount(req.sessionToken),
      ...auth.sessionInfo(req.sessionToken),
    });
  });

  // 二次验证：{ password } 或 { passkey }（浏览器返回的 passkey 结果）。成功后 5 分钟内可以添加、删除 passkey。
  // 失败返回 400（不是 401，避免页面当作会话失效），计入登录限速
  router.post("/auth/reauth", async (req, res) => {
    const body = requireObject(req.body);
    const usePasskey = body.passkey !== undefined;
    if (!usePasskey && !passwordLogin().active) {
      passwordLoginDisabled(res, 403);
      return;
    }
    const result = usePasskey
      ? await auth.reauthWithPasskey(req.ip, req.sessionToken, () => passkeys.verifyReauth(body.passkey, req.sessionToken))
      : await auth.reauthWithPassword(req.ip, req.sessionToken, body.password);
    if (result.ok) {
      res.status(204).end();
      return;
    }
    if (!result.locked) {
      console.warn("面板二次验证失败:", req.ip);
    }
    sendAuthFailure(res, result, 400, usePasskey ? "passkey_failed" : "wrong_password");
  });

  router.get("/auth/passkeys", (req, res) => {
    res.json({ passkey: passkeyView(), passkeys: passkeys.list() });
  });

  router.post("/auth/passkeys/options", recentAuth, async (req, res) => {
    res.json(await passkeys.registrationOptions(req.sessionToken));
  });

  // { name?, response }：校验浏览器返回的结果并保存
  router.post("/auth/passkeys", recentAuth, async (req, res) => {
    const body = requireObject(req.body);
    const passkey = await passkeys.register(body.response, body.name, req.sessionToken);
    console.info(`已添加 passkey「${passkey.name}」`);
    res.status(201).json({ passkey });
  });

  router.patch("/auth/passkeys/:id", recentAuth, async (req, res) => {
    const passkey = await passkeys.rename(req.params.id, requireObject(req.body).name);
    res.json({ passkey });
  });

  // 删除后，用这个 passkey 登录的其他会话立即失效（当前会话保留）
  router.delete("/auth/passkeys/:id", recentAuth, async (req, res) => {
    const passkey = await passkeys.remove(req.params.id);
    const ended = auth.endPasskeySessions(passkey.id, req.sessionToken);
    console.info(`已删除 passkey「${passkey.name}」${ended > 0 ? `，结束了用它登录的 ${ended} 个会话` : ""}`);
    res.status(204).end();
  });

  // { enabled }：在设置中打开或关闭密码登录。关闭要求 5 分钟内用 passkey 验证过（确认它在当前域名下能用），
  // 并且当前域名下至少有一个可用的 passkey；关闭后其他用密码登录的会话立即失效。打开只要求 5 分钟内验证过
  router.patch("/auth/password-login", async (req, res) => {
    const body = requireObject(req.body);
    const unknown = Object.keys(body).filter((key) => key !== "enabled");
    if (typeof body.enabled !== "boolean" || unknown.length > 0) {
      throw badRequest("只能提交 { enabled: true | false }");
    }
    if (!body.enabled) {
      if (passkeys.usableCount() === 0) {
        throw new PanelError(409, "no_usable_passkey", "当前域名下没有可用的 passkey，添加后才能关闭密码登录");
      }
      if (!auth.isRecentlyVerified(req.sessionToken, "passkey")) {
        reauthRequired(res, "passkey");
        return;
      }
    } else if (!auth.isRecentlyVerified(req.sessionToken)) {
      reauthRequired(res);
      return;
    }
    await store.update((data) => {
      data.auth.passwordLogin = body.enabled;
    });
    const state = passwordLogin();
    if (body.enabled) {
      console.info("已打开密码登录");
    } else {
      const ended = state.active ? 0 : auth.endPasswordSessions(req.sessionToken);
      console.info(`已关闭密码登录${ended > 0 ? `，结束了用密码登录的 ${ended} 个会话` : ""}${state.forced ? "（PANEL_FORCE_PASSWORD_LOGIN 生效期间仍可用密码登录）" : ""}`);
    }
    res.json({ passwordLogin: state });
  });

  // 退出其他设备：结束当前会话以外的所有会话。会话跨重启保留，不能再靠重启面板让其他设备退出
  router.post("/auth/logout-others", recentAuth, (req, res) => {
    const ended = auth.endOtherSessions(req.sessionToken);
    console.info(`已退出其他设备，结束了 ${ended} 个会话`);
    res.json({ ended });
  });

  router.post("/auth/logout", (req, res) => {
    auth.destroySession(req.sessionToken);
    cookies.clearSessionCookie(req, res);
    res.status(204).end();
  });

  router.post("/auth/password", async (req, res) => {
    if (!passwordLogin().active) {
      passwordLoginDisabled(res, 409);
      return;
    }
    const body = req.body || {};
    const result = await auth.changePassword(req.ip, body.current, body.next);
    if (result.ok) {
      cookies.setSessionCookie(req, res, result.token);
      console.info("面板密码已修改，其他会话已失效");
      res.status(204).end();
      return;
    }
    if (result.error === "too_many_attempts") {
      sendAuthFailure(res, { locked: true, retryAfterMs: result.retryAfterMs });
      return;
    }
    if (result.error === "wrong_password") {
      console.warn("修改面板密码：当前密码不正确:", req.ip);
    }
    const status = result.error === "password_from_env" ? 409 : 400;
    res.status(status).json({ error: result.error, minPasswordLength: MIN_PASSWORD_LENGTH });
  });

  return router;
}

module.exports = { authRoutes, publicAuthRoutes };
