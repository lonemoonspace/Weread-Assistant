const { Cron } = require("croner");
const { PanelError } = require("./errors");
const { describeSchedule, schedulePatterns } = require("./schedules");

/**
 * 调度器：按账号的调度规则在面板时区的对应时间把运行加入队列。
 * panel.json 中的时区、账号启用状态或调度规则变化后整体重建定时任务，修改立即生效。
 * 面板停机期间错过的时间不补跑；账号已在运行或排队、已停用时跳过本次触发并记录日志。
 */
function createScheduler({ store, runner }) {
  let jobs = [];
  let closed = false;

  function fire(accountId, rule) {
    const label = `账号 ${accountId}，规则 ${rule.id}（${describeSchedule(rule)}）`;
    try {
      const run = runner.enqueue(accountId, { mode: "read", trigger: "schedule", scheduleId: rule.id });
      console.info(`定时触发：${label}，运行 ${run.id}`);
    } catch (e) {
      if (e instanceof PanelError) {
        console.info(`定时触发跳过：${label}：${e.message}`);
        return;
      }
      console.error(`定时触发失败：${label}:`, e);
    }
  }

  function stopAll() {
    for (const job of jobs) {
      job.cron.stop();
    }
    jobs = [];
  }

  function reload() {
    if (closed) {
      return;
    }
    stopAll();
    const data = store.get();
    const { timezone } = data.settings;
    for (const account of data.accounts) {
      if (!account.enabled) {
        continue;
      }
      for (const rule of account.schedules || []) {
        if (!rule.enabled) {
          continue;
        }
        let patterns;
        try {
          patterns = schedulePatterns(rule);
        } catch (e) {
          console.warn(`跳过无法解析的调度规则：账号 ${account.id}，规则 ${rule.id}：${e.message}`);
          continue;
        }
        for (const pattern of patterns) {
          try {
            const cron = new Cron(pattern, { timezone }, () => fire(account.id, rule));
            jobs.push({ accountId: account.id, ruleId: rule.id, pattern, cron });
          } catch (e) {
            console.warn(`跳过无效的调度规则：账号 ${account.id}，规则 ${rule.id}（${pattern}）：${e.message}`);
          }
        }
      }
    }
  }

  // 只有调度相关的内容（时区、账号启用状态与规则）变化时才重建：其他写入（修改名称、配置、挑战等）不必重建全部定时任务
  const scheduleKey = () => {
    const data = store.get();
    return JSON.stringify([
      data.settings.timezone,
      data.accounts.map((account) => [account.id, account.enabled, account.schedules || []]),
    ]);
  };
  let lastKey = scheduleKey();
  reload();
  const unsubscribe = store.subscribe(() => {
    const key = scheduleKey();
    if (key !== lastKey) {
      lastKey = key;
      reload();
    }
  });

  return {
    reload,
    // 当前生效的定时任务，供排查与测试
    jobs() {
      return jobs.map(({ accountId, ruleId, pattern, cron }) => ({
        accountId,
        ruleId,
        pattern,
        nextRun: cron.nextRun() ? cron.nextRun().toISOString() : null,
      }));
    },
    close() {
      closed = true;
      unsubscribe();
      stopAll();
    },
  };
}

module.exports = {
  createScheduler,
};
