import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { TRIGGER_LABELS, formatHours, formatMinutes } from "../format.js";
import { go } from "../router.js";
import { notify, state } from "../store.js";

const RANGES = [30, 90, 365];
const STATUS_TEXT = { "not-started": "未开始", active: "进行中", ended: "已结束" };
const RESULT_LABELS = { success: "成功", failed: "失败", stopped: "停止", interrupted: "中断" };

// 柱状图的坐标（viewBox 单位）。宽度随容器伸缩，柱子的位置与尺寸写在 SVG 属性上
const BAR_WIDTH = 600;
const BAR_HEIGHT = 160;
// 热力图：每格 11、间隔 3；左侧留出星期标签，上方留出月份标签
const CELL = 11;
const STEP = 14;
const HEAT_LEFT = 26;
const HEAT_TOP = 16;
const WEEKDAY_LABELS = [
  [0, "一"],
  [2, "三"],
  [4, "五"],
];

function weekdayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// 统计页：全部账号或某个账号的概览数字、近期趋势、年度热力图、运行情况与挑战进度
export const StatsPage = {
  props: { account: String },
  setup(props) {
    const data = ref(null);
    const days = ref(30);
    const loading = ref(false);
    // 手机宽度下热力图只显示最近半年
    const narrow = ref(false);
    const media = window.matchMedia("(max-width: 576px)");
    const syncNarrow = () => {
      narrow.value = media.matches;
    };
    let latest = 0;

    const target = computed(() => props.account || "all");

    async function load() {
      const request = ++latest;
      loading.value = true;
      try {
        const result = await api(`stats?account=${encodeURIComponent(target.value)}&days=${days.value}`);
        if (request === latest) {
          data.value = result;
        }
      } catch (error) {
        if (request === latest) {
          notify(error.message, "error");
        }
      } finally {
        if (request === latest) {
          loading.value = false;
        }
      }
    }

    const chooseAccount = (event) => go(event.target.value === "all" ? "/stats" : `/stats/${event.target.value}`);
    const chooseRange = (value) => {
      days.value = value;
      load();
    };

    // ---------- 柱状图 ----------
    const bars = computed(() => {
      if (!data.value) {
        return null;
      }
      const trend = data.value.trend;
      const goal = data.value.goalMinutes || 0;
      const max = Math.max(goal, ...trend.map((day) => day.minutes), data.value.checkInMinutes);
      const top = Math.ceil(max / 10) * 10;
      const step = BAR_WIDTH / trend.length;
      const gap = trend.length > 90 ? 0 : Math.min(2, step * 0.2);
      const y = (minutes) => BAR_HEIGHT - (minutes / top) * BAR_HEIGHT;
      return {
        top,
        goalY: goal ? y(goal) : null,
        items: trend.map((day, i) => {
          const height = (day.minutes / top) * BAR_HEIGHT;
          const past = day.date < data.value.today;
          return {
            ...day,
            x: i * step + gap / 2,
            width: Math.max(step - gap, 0.5),
            y: BAR_HEIGHT - height,
            height,
            // 已经过去却没打卡的日子在底部画一条红线
            missed: past && !day.checkedIn,
          };
        }),
      };
    });

    // ---------- 热力图 ----------
    const heat = computed(() => {
      if (!data.value) {
        return null;
      }
      const days = narrow.value ? data.value.heatmap.slice(-182) : data.value.heatmap;
      const offset = weekdayOf(days[0].date);
      const cells = days.map((day, i) => {
        const index = i + offset;
        return { ...day, x: HEAT_LEFT + Math.floor(index / 7) * STEP, y: HEAT_TOP + (index % 7) * STEP };
      });
      const weeks = Math.ceil((days.length + offset) / 7);
      // 每月第一天所在的列标出月份
      const months = cells
        .filter((cell) => cell.date.endsWith("-01"))
        .map((cell) => ({ key: cell.date, x: cell.x, label: `${Number(cell.date.slice(5, 7))}月` }));
      return {
        width: HEAT_LEFT + weeks * STEP,
        height: HEAT_TOP + 7 * STEP,
        cells,
        months,
      };
    });
    // 手机宽度下热力图横向滚动，默认显示最近的日子
    const heatScroll = ref(null);
    watch(heat, () =>
      nextTick(() => {
        if (heatScroll.value) {
          heatScroll.value.scrollLeft = heatScroll.value.scrollWidth;
        }
      })
    );
    const dayLink = (date) => (target.value === "all" ? null : `#/accounts/${target.value}/history/${date}`);

    // ---------- 运行情况 ----------
    const results = computed(() =>
      data.value ? Object.entries(RESULT_LABELS).map(([key, label]) => ({ key, label, count: data.value.runs.byStatus[key] })) : []
    );
    const triggers = computed(() =>
      data.value
        ? Object.entries(data.value.runs.byTrigger)
            .filter(([, count]) => count > 0)
            .map(([key, count]) => ({ key, label: TRIGGER_LABELS[key] || key, count }))
        : []
    );
    const share = (count) => (data.value && data.value.runs.total ? Math.round((count / data.value.runs.total) * 100) : 0);

    onMounted(() => {
      syncNarrow();
      media.addEventListener("change", syncNarrow);
      load();
    });
    onBeforeUnmount(() => media.removeEventListener("change", syncNarrow));
    watch(target, load);
    // 有运行结束时刷新
    watch(() => Object.values(state.finished).map((run) => run.id).join(","), load);

    return {
      data,
      days,
      loading,
      target,
      bars,
      heat,
      heatScroll,
      narrow,
      results,
      triggers,
      share,
      dayLink,
      chooseAccount,
      chooseRange,
      formatHours,
      formatMinutes,
      RANGES,
      STATUS_TEXT,
      WEEKDAY_LABELS,
      CELL,
      STEP,
      HEAT_TOP,
      BAR_WIDTH,
      BAR_HEIGHT,
    };
  },
  template: `
    <section class="stats-page">
      <div class="stats-head">
        <h2>统计</h2>
        <div class="stats-controls">
          <select aria-label="统计范围" :value="target" @change="chooseAccount">
            <option value="all">全部账号</option>
            <option v-for="item in (data ? data.accounts : [])" :key="item.id" :value="item.id">{{ item.name }}（{{ item.id }}）</option>
          </select>
          <div class="segmented" role="group" aria-label="趋势天数">
            <button v-for="value in RANGES" :key="value" type="button" class="outline small" :aria-pressed="days === value ? 'true' : 'false'" @click="chooseRange(value)">{{ value }} 天</button>
          </div>
        </div>
      </div>

      <template v-if="data">
        <section class="metrics-grid" :aria-busy="loading">
          <div class="metric-card">
            <div class="metric-head">连续打卡</div>
            <div class="metric-number">{{ data.summary.currentStreak }}<span class="metric-unit">天</span></div>
            <div class="metric-tip muted">最长 {{ data.summary.longestStreak.days }} 天<template v-if="data.summary.longestStreak.endDate">（到 {{ data.summary.longestStreak.endDate }}）</template></div>
          </div>
          <div class="metric-card">
            <div class="metric-head">本周</div>
            <div class="metric-number">{{ data.summary.week.minutes }}<span class="metric-unit">分钟</span></div>
            <div class="metric-tip muted">打卡 {{ data.summary.week.checkedDays }} 天</div>
          </div>
          <div class="metric-card">
            <div class="metric-head">本月</div>
            <div class="metric-number">{{ data.summary.month.minutes }}<span class="metric-unit">分钟</span></div>
            <div class="metric-tip muted">打卡 {{ data.summary.month.checkedDays }} 天</div>
          </div>
          <div class="metric-card">
            <div class="metric-head">今年</div>
            <div class="metric-number">{{ formatHours(data.summary.year.minutes).replace(' 小时', '') }}<span class="metric-unit">小时</span></div>
            <div class="metric-tip muted">打卡 {{ data.summary.year.checkedDays }} 天</div>
          </div>
          <div class="metric-card">
            <div class="metric-head">近 30 天日均</div>
            <div class="metric-number">{{ data.summary.averageMinutes30 }}<span class="metric-unit">分钟</span></div>
            <div class="metric-tip muted">共 {{ formatMinutes(data.summary.last30.minutes) }}</div>
          </div>
        </section>

        <article v-if="data.challenge" class="challenge">
          <header>
            <strong>{{ data.challenge.label }}</strong> · {{ STATUS_TEXT[data.challenge.status] }}
            <span v-if="data.challenge.achieved" class="badge status-success">已达成</span>
          </header>
          <p class="challenge-main">
            第 <strong>{{ data.challenge.dayNumber }}</strong> 天 / {{ data.challenge.totalDays }}，
            已打卡 <strong>{{ data.challenge.checkedDays }}</strong> 天 / {{ data.challenge.requiredDays }}，
            累计 <strong>{{ formatHours(data.challenge.totalMinutes) }}</strong> / {{ formatHours(data.challenge.requiredMinutes) }}
          </p>
          <progress :value="Math.min(data.challenge.checkedDays, data.challenge.requiredDays)" :max="data.challenge.requiredDays"></progress>
          <p v-if="data.challenge.status !== 'ended'" :class="data.challenge.missedDays > data.challenge.allowedMissedDays ? 'error-text' : 'muted'">
            <template v-if="data.challenge.minutesPerDayNeeded > 0">剩余 {{ data.challenge.remainingDays }} 天平均每天还需读 {{ data.challenge.minutesPerDayNeeded }} 分钟，</template>
            <template v-else>累计时长已满足，</template>
            还能漏 {{ data.challenge.missesLeft }} 天（已漏 {{ data.challenge.missedDays }} 天）
          </p>
        </article>

        <article class="chart-card">
          <header>
            <strong>近 {{ data.rangeDays }} 天</strong>
            <span class="muted chart-legend">
              <span class="legend-item"><span class="legend-swatch swatch-checked"></span>已打卡</span>
              <span class="legend-item"><span class="legend-swatch swatch-partial"></span>未满 {{ data.checkInMinutes }} 分钟</span>
              <span v-if="bars.goalY !== null" class="legend-item"><span class="legend-swatch swatch-goal"></span>每日目标 {{ data.goalMinutes }} 分钟</span>
            </span>
          </header>
          <div class="bar-chart-wrap">
            <span class="chart-axis-top muted">{{ bars.top }} 分钟</span>
            <svg class="bar-chart" :viewBox="'0 0 ' + BAR_WIDTH + ' ' + (BAR_HEIGHT + 4)" preserveAspectRatio="none" width="100%" height="180" role="img" :aria-label="'近 ' + data.rangeDays + ' 天每日阅读分钟数'">
              <line class="chart-baseline" x1="0" :x2="BAR_WIDTH" :y1="BAR_HEIGHT" :y2="BAR_HEIGHT" vector-effect="non-scaling-stroke"></line>
              <g v-for="bar in bars.items" :key="bar.date">
                <rect :class="bar.checkedIn ? 'bar-checked' : 'bar-partial'" :x="bar.x" :y="bar.y" :width="bar.width" :height="bar.height">
                  <title>{{ bar.date }}：{{ bar.minutes }} 分钟{{ bar.checkedIn ? '，已打卡' : '' }}</title>
                </rect>
                <rect v-if="bar.missed" class="bar-missed" :x="bar.x" :y="BAR_HEIGHT" :width="bar.width" height="4">
                  <title>{{ bar.date }}：未打卡</title>
                </rect>
              </g>
              <line v-if="bars.goalY !== null" class="chart-goal" x1="0" :x2="BAR_WIDTH" :y1="bars.goalY" :y2="bars.goalY" vector-effect="non-scaling-stroke"></line>
            </svg>
            <div class="chart-axis muted"><span>{{ data.trend[0].date }}</span><span>{{ data.today }}</span></div>
          </div>
        </article>

        <article class="chart-card">
          <header>
            <strong>{{ narrow ? "最近半年" : "最近一年" }}</strong>
            <span class="muted chart-legend">
              少
              <svg v-for="level in [0, 1, 2, 3, 4]" :key="level" class="legend-heat" width="11" height="11" aria-hidden="true"><rect :class="'heat-' + level" width="11" height="11" rx="2"></rect></svg>
              多
            </span>
          </header>
          <div ref="heatScroll" class="heatmap-scroll">
            <svg class="heatmap" :viewBox="'0 0 ' + heat.width + ' ' + heat.height" :width="heat.width" :height="heat.height" role="img" aria-label="最近一年每天的阅读分钟数">
              <text v-for="month in heat.months" :key="month.key" class="heat-label" :x="month.x" y="10">{{ month.label }}</text>
              <text v-for="[row, label] in WEEKDAY_LABELS" :key="label" class="heat-label" x="0" :y="HEAT_TOP + row * STEP + 9">{{ label }}</text>
              <template v-for="cell in heat.cells" :key="cell.date">
                <a v-if="dayLink(cell.date) && cell.minutes" :href="dayLink(cell.date)">
                  <rect :class="'heat-' + cell.level" :x="cell.x" :y="cell.y" :width="CELL" :height="CELL" rx="2"><title>{{ cell.date }}：{{ cell.minutes }} 分钟</title></rect>
                </a>
                <rect v-else :class="'heat-' + cell.level" :x="cell.x" :y="cell.y" :width="CELL" :height="CELL" rx="2"><title>{{ cell.date }}：{{ cell.minutes }} 分钟</title></rect>
              </template>
            </svg>
          </div>
          <p v-if="target !== 'all'" class="muted">点有阅读的日子可以查看当天及以前的运行历史。</p>
        </article>

        <article class="chart-card">
          <header><strong>运行情况（近 {{ data.rangeDays }} 天）</strong></header>
          <p v-if="!data.runs.total" class="muted">这段时间没有结束的运行。</p>
          <template v-else>
            <div class="run-bars">
              <div v-for="item in results" :key="item.key" class="run-bar">
                <span>{{ item.label }}</span>
                <progress :class="'run-' + item.key" :value="item.count" :max="data.runs.total"></progress>
                <span class="run-count">{{ item.count }}<small class="muted">（{{ share(item.count) }}%）</small></span>
              </div>
            </div>
            <p>
              按触发方式：<template v-for="(item, index) in triggers" :key="item.key">{{ index ? '、' : '' }}{{ item.label }} {{ item.count }}</template>
            </p>
            <p class="muted">
              共 {{ data.runs.total }} 次；失败后自动重试救回 {{ data.runs.rescued }} 次，每日目标补跑 {{ data.runs.catchups }} 次，需要扫码 {{ data.runs.loginPrompted }} 次
            </p>
          </template>
        </article>

        <p class="muted">每天阅读满 {{ data.checkInMinutes }} 分钟算打卡；日期按 {{ data.timezone }} 时区划分<template v-if="target === 'all'">；全部账号时分钟数相加，任一账号打卡即算当天打卡</template>。{{ data.note }}。</p>
      </template>
      <p v-else aria-busy="true">加载中…</p>
    </section>`,
};
