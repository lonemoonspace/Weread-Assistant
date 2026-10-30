import { computed, onMounted, reactive, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { formatHours, formatMinutes } from "../format.js";
import { notify, refreshAccounts, state } from "../store.js";

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

const STATUS_TEXT = { "not-started": "未开始", active: "进行中", ended: "已结束" };

// 打卡日历：按月显示每天的阅读分钟与是否打卡；本轮挑战的设置与进度
export const CalendarTab = {
  props: { account: Object },
  setup(props) {
    const data = ref(null);
    const month = ref("");
    const loading = ref(false);
    const form = reactive({ type: "month", startDate: "" });
    const saving = ref(false);
    // 连续翻月时只采用最近一次请求的结果，显示的月份与按钮一致
    let latest = 0;

    async function load() {
      const request = ++latest;
      loading.value = true;
      try {
        const query = month.value ? `?month=${month.value}` : "";
        const result = await api(`accounts/${props.account.id}/calendar${query}`);
        if (request !== latest) {
          return;
        }
        data.value = result;
        month.value = data.value.month;
        if (props.account.challenge) {
          Object.assign(form, props.account.challenge);
        } else if (!form.startDate) {
          form.startDate = data.value.today.date;
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

    // 周一开始；月初之前补空格
    const cells = computed(() => {
      if (!data.value) {
        return [];
      }
      const [y, m] = data.value.month.split("-").map(Number);
      const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
      const blanks = Array.from({ length: firstWeekday }, (_, i) => ({ blank: true, key: `b${i}` }));
      return [...blanks, ...data.value.days.map((day) => ({ ...day, key: day.date, number: Number(day.date.slice(8)) }))];
    });

    const isCurrentMonth = computed(() => data.value && data.value.today.date.startsWith(data.value.month));

    async function saveChallenge(challenge) {
      if (saving.value) {
        return;
      }
      saving.value = true;
      try {
        await api(`accounts/${props.account.id}`, { method: "PATCH", body: { challenge } });
        await refreshAccounts();
        notify(challenge ? "已保存挑战设置" : "已清除挑战设置");
        await load();
      } catch (error) {
        notify(error.message, "error");
      } finally {
        saving.value = false;
      }
    }

    onMounted(load);
    watch(() => state.finished[props.account.id], load);

    return {
      data,
      month,
      loading,
      saving,
      cells,
      form,
      isCurrentMonth,
      prev: () => {
        month.value = shiftMonth(month.value, -1);
        load();
      },
      next: () => {
        month.value = shiftMonth(month.value, 1);
        load();
      },
      save: () => saveChallenge({ type: form.type, startDate: form.startDate }),
      clear: () => saveChallenge(null),
      formatHours,
      formatMinutes,
      STATUS_TEXT,
      WEEKDAYS: ["一", "二", "三", "四", "五", "六", "日"],
    };
  },
  template: `
    <section v-if="data">
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
        <p :class="data.challenge.missedDays > data.challenge.allowedMissedDays ? 'error-text' : 'muted'">
          已漏打卡 {{ data.challenge.missedDays }} 天（最多可漏 {{ data.challenge.allowedMissedDays }} 天）·
          {{ data.challenge.startDate }} 至 {{ data.challenge.endDate }}
        </p>
      </article>

      <div class="month-nav">
        <button type="button" class="outline small" @click="prev" aria-label="上个月">‹</button>
        <strong>{{ month.replace("-", " 年 ") }} 月</strong>
        <button type="button" class="outline small" @click="next" aria-label="下个月">›</button>
      </div>
      <p>
        本月阅读 {{ formatMinutes(data.monthMinutes) }}，打卡 {{ data.monthCheckedDays }} 天
        <template v-if="isCurrentMonth">
          · 今天 {{ data.today.minutes }} 分钟
          <span v-if="data.today.checkedIn" class="badge status-success">已打卡</span>
          <span v-else class="badge status-failed">未达到 {{ data.checkInMinutes }} 分钟</span>
        </template>
      </p>
      <div class="calendar" :aria-busy="loading">
        <div v-for="name in WEEKDAYS" :key="name" class="weekday">{{ name }}</div>
        <div
          v-for="cell in cells"
          :key="cell.key"
          class="day"
          :class="{
            blank: cell.blank,
            checked: cell.checkedIn,
            partial: !cell.checkedIn && cell.minutes > 0,
            today: cell.date === data.today.date,
            missed: cell.date === data.today.date && !cell.checkedIn,
            future: cell.future,
          }"
        >
          <template v-if="!cell.blank">
            <span class="day-number">{{ cell.number }}</span>
            <span v-if="cell.minutes" class="day-minutes">{{ cell.minutes }} 分</span>
          </template>
        </div>
      </div>
      <p class="muted">每天阅读满 {{ data.checkInMinutes }} 分钟算打卡；日期按 {{ data.timezone }} 时区划分。{{ data.note }}。</p>

      <details>
        <summary>阅读挑战设置</summary>
        <form class="grid" @submit.prevent="save">
          <label>
            类型
            <select v-model="form.type">
              <option value="month">月卡（30 天内打卡 29 天、累计 30 小时）</option>
              <option value="year">年卡（365 天内打卡 360 天、累计 300 小时）</option>
            </select>
          </label>
          <label>
            开始日期
            <input type="date" v-model="form.startDate" required>
          </label>
          <div class="form-actions">
            <button type="submit" :aria-busy="saving" :disabled="saving">保存</button>
            <button v-if="data.challenge" type="button" class="secondary" :disabled="saving" @click="clear">清除</button>
          </div>
        </form>
      </details>
    </section>
    <p v-else aria-busy="true">加载中…</p>`,
};
