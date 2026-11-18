// 模拟微信读书官方 API 网关（POST /api/agent/gateway），回包结构按官方 skills/*.md 的说明，供 panel smoke 与单元测试使用。
// data：{ books: [{ bookId, title, author, sort, noteCount, reviewCount, bookmarkCount, bookmarks: [...], reviews: [...], chapters: [...] }], readdata }
// 只接受 Authorization: Bearer <key>；错误的 key 返回 errcode -2012。requests 记录收到的请求体
const http = require("http");

function startMockOfficial({ key, data = { books: [] } }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const send = (body, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/api/agent/gateway") {
        send({ errcode: 404, errmsg: "not found" }, 404);
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch (_) {
        send({ errcode: -1, errmsg: "bad json" }, 400);
        return;
      }
      requests.push(body);
      if (req.headers.authorization !== `Bearer ${key}`) {
        send({ errcode: -2012, errmsg: "API Key 无效" });
        return;
      }
      if (!body.skill_version) {
        send({ errcode: -1, errmsg: "缺少 skill_version" });
        return;
      }
      const findBook = (id) => data.books.find((book) => book.bookId === id);
      const bookInfo = (book) => ({ bookId: book.bookId, title: book.title, author: book.author, cover: `https://cover.example/${book.bookId}.jpg` });
      switch (body.api_name) {
        case "/user/notebooks": {
          const count = Number(body.count) || 20;
          const sorted = [...data.books].sort((a, b) => b.sort - a.sort);
          const start = body.lastSort ? sorted.findIndex((book) => book.sort < Number(body.lastSort)) : 0;
          const page = start < 0 ? [] : sorted.slice(start, start + count);
          send({
            errcode: 0,
            totalBookCount: data.books.length,
            totalNoteCount: data.books.reduce((sum, book) => sum + book.noteCount + book.reviewCount + book.bookmarkCount, 0),
            hasMore: start >= 0 && start + count < sorted.length ? 1 : 0,
            books: page.map((book) => ({
              bookId: book.bookId,
              book: bookInfo(book),
              reviewCount: book.reviewCount,
              noteCount: book.noteCount,
              bookmarkCount: book.bookmarkCount,
              readingProgress: book.readingProgress || 0,
              markedStatus: book.markedStatus || 0,
              sort: book.sort,
            })),
          });
          return;
        }
        case "/book/bookmarklist": {
          const book = findBook(body.bookId);
          send({ errcode: 0, updated: book ? book.bookmarks : [], chapters: book ? book.chapters : [], book: book ? bookInfo(book) : {} });
          return;
        }
        case "/review/list/mine": {
          const book = findBook(body.bookid);
          const all = book ? book.reviews : [];
          const count = Number(body.count) || 20;
          const start = Number(body.synckey) || 0;
          const page = all.slice(start, start + count);
          send({
            errcode: 0,
            reviews: page.map((review) => ({ review })),
            totalCount: all.length,
            hasMore: start + count < all.length ? 1 : 0,
            synckey: start + page.length,
          });
          return;
        }
        case "/readdata/detail":
          send({ errcode: 0, ...(data.readdata || {}) });
          return;
        default:
          send({ errcode: -1, errmsg: `未知接口 ${body.api_name}` });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/api/agent/gateway`,
        requests,
        data,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startMockOfficial };
