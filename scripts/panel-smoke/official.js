// 面板 smoke：微信读书官方 API（API Key 配置与测试；笔记同步见后续场景）。网关为 scripts/fixtures/mock-official.js

const assert = require("assert");
const { startMockOfficial } = require("../fixtures/mock-official");

const KEY = "wrk-smoke-key-123456";

const BOOKS = [
  {
    bookId: "100001",
    title: "测试之书",
    author: "某作者",
    sort: 1763000000,
    noteCount: 2,
    reviewCount: 1,
    bookmarkCount: 1,
    chapters: [
      { chapterUid: 1, chapterIdx: 1, title: "第一章" },
      { chapterUid: 2, chapterIdx: 2, title: "第二章" },
    ],
    bookmarks: [
      { bookmarkId: "100001_1_10-20", bookId: "100001", chapterUid: 1, markText: "第一段划线", createTime: 1762000000, type: 1, range: "10-20", colorStyle: 1 },
      { bookmarkId: "100001_2_5-9", bookId: "100001", chapterUid: 2, markText: "第二段划线", createTime: 1762100000, type: 1, range: "5-9", colorStyle: 2 },
    ],
    reviews: [
      { reviewId: "r1", content: "我的想法", abstract: "第一段划线", range: "10-20", chapterUid: 1, chapterIdx: 1, createTime: 1762000100, star: -1, chapterName: "第一章" },
    ],
  },
];

module.exports = async function officialScenarios({ scenario, startAuthed }) {
  await scenario("微信读书 API Key：只能在账号中设置、格式校验、只返回掩码；测试 API Key 成功与失败", async () => {
    const gateway = await startMockOfficial({ key: KEY, data: { books: BOOKS } });
    try {
      const panel = await startAuthed({ officialApi: { gatewayUrl: gateway.url, retryDelayMs: 1 } });
      await panel.call("POST", "api/accounts", { id: "me" });

      const schema = (await panel.call("GET", "api/schema")).json;
      const field = schema.fields.find((item) => item.key === "wereadApiKey");
      assert.deepStrictEqual([field.secret, field.accountOnly, field.group], [true, true, "official"]);
      assert.strictEqual((await panel.call("PATCH", "api/settings", { defaults: { wereadApiKey: KEY } })).status, 400, "全局默认中不能设置");
      assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { overrides: { wereadApiKey: "sk-123" } })).status, 400, "格式不对");

      // 没有配置时 400
      assert.strictEqual((await panel.call("POST", "api/accounts/me/official/test", {})).status, 400);

      assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { overrides: { wereadApiKey: KEY } })).status, 200);
      const account = (await panel.call("GET", "api/accounts/me")).json.account;
      assert.strictEqual(account.overrides.wereadApiKey, "••••••", "只返回掩码");

      const tested = await panel.call("POST", "api/accounts/me/official/test", {});
      assert.deepStrictEqual(tested.json, { ok: true, totalBookCount: 1, totalNoteCount: 4, upgradeInfo: "" });
      const last = gateway.requests.at(-1);
      assert.deepStrictEqual([last.api_name, last.count, typeof last.skill_version], ["/user/notebooks", 1, "string"]);

      // 换成网关不认的 key：返回失败原因，不出现 key
      const wrong = "wrk-wrong-key-123456";
      await panel.call("PATCH", "api/accounts/me", { overrides: { wereadApiKey: wrong } });
      const failed = (await panel.call("POST", "api/accounts/me/official/test", {})).json;
      assert.deepStrictEqual([failed.ok, failed.kind], [false, "key"]);
      assert.ok(!failed.error.includes(wrong));
    } finally {
      await gateway.close();
    }
  });
};
