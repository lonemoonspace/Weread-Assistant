const fs = require("fs");
const path = require("path");
const { newRunId } = require(path.resolve(__dirname, "..", "..", "src", "panel", "runs"));

// 直接写入一条运行记录（用于构造跨天、旧格式等数据）；marks 为每分钟阅读完成的时间
function writeRun(dataDir, accountId, { queuedAt, marks, files = {}, ...meta }) {
  const id = newRunId(new Date(queuedAt));
  const dir = path.join(dataDir, "runs", accountId, id);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    id,
    accountId,
    mode: "read",
    trigger: "manual",
    status: "success",
    queuedAt,
    startedAt: queuedAt,
    endedAt: queuedAt,
    minutes: marks ? marks.length : 0,
    ...meta,
  };
  if (marks) {
    record.minuteMarks = marks;
  }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(record));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return id;
}

// 从 start 起每分钟一条，共 count 条
function minutesFrom(start, count) {
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(start) + (i + 1) * 60000).toISOString());
}

module.exports = {
  minutesFrom,
  writeRun,
};
