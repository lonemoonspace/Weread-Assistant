import { computed, onMounted, onUnmounted, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { SCHEDULE_TYPE_LABELS, formatNextRun, formatShort } from "../format.js";
import { setLeaveGuard } from "../router.js";
import { notify, refreshAccounts, timezone } from "../store.js";

const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12];
let nextKey = 0;

// 接口中的规则 → 表单中可编辑的规则（每天固定时间以逗号分隔的文本编辑）
function toEditable(rule) {
  nextKey += 1;
  return {
    key: nextKey,
    id: rule.id,
    type: rule.type,
    timesText: rule.times ? rule.times.join(", ") : "06:00",
    hours: rule.hours || 6,
    minute: rule.minute || 0,
    expression: rule.expression || "0 6 * * *",
    enabled: rule.enabled !== false,
    jitterMinutes: rule.jitterMinutes || 0,
    description: rule.description || "",
    nextRuns: rule.nextRuns || [],
  };
}

function toPayload(rule) {
  const base = { id: rule.id || undefined, type: rule.type, enabled: rule.enabled, jitterMinutes: Number(rule.jitterMinutes) || 0 };
  if (rule.type === "daily") {
    return { ...base, times: rule.timesText.split(/[\s,，、]+/).filter(Boolean) };
  }
  if (rule.type === "interval") {
    return { ...base, hours: Number(rule.hours), minute: Number(rule.minute) };
  }
  return { ...base, expression: rule.expression };
}

// 每日目标：到检查时间后当天分钟数不够就补跑差额
// 有未保存的修改时发出 dirty-change，由调度页并入离开确认
const GoalCard = {
  props: { account: Object },
  emits: ["dirty-change"],
  setup(props, { emit }) {
    const view = ref(null);
    const form = ref({ enabled: false, minutes: 30, checkAt: "22:00" });
    const error = ref("");
    const busy = ref(false);
    // 上次加载或保存时的表单，用于判断是否有未保存的修改
    const saved = ref("");
    const snapshot = () => JSON.stringify({ enabled: form.value.enabled, minutes: Number(form.value.minutes), checkAt: form.value.checkAt });
    const dirty = computed(() => view.value !== null && snapshot() !== saved.value);
    watch(dirty, (value) => emit("dirty-change", value));

    function apply(data) {
      view.value = data;
      const goal = data.goal;
      form.value = goal
        ? { ...goal }
        : { enabled: false, minutes: data.suggestedMinutes || 30, checkAt: "22:00" };
      saved.value = snapshot();
    }

    async function load() {
      try {
        apply(await api(`accounts/${props.account.id}/goal`));
      } catch (e) {
        notify(e.message, "error");
      }
    }

    async function save() {
      busy.value = true;
      error.value = "";
      try {
        const goal = { enabled: form.value.enabled, minutes: Number(form.value.minutes), checkAt: form.value.checkAt };
        apply(await api(`accounts/${props.account.id}/goal`, { method: "PUT", body: { goal } }));
        await refreshAccounts();
        notify(goal.enabled ? "每日目标已保存" : "每日目标已关闭");
      } catch (e) {
        error.value = e.message;
      } finally {
        busy.value = false;
      }
    }

    function useSuggested() {
      form.value.minutes = view.value.suggestedMinutes;
    }

    onMounted(load);
    return { view, form, error, busy, dirty, save, useSuggested };
  },
  template: `
    <article class="goal-card">
      <h3>每日目标</h3>
      <p class="muted">每天到检查时间，如果今天累计阅读不到目标分钟数，就补跑差额。补跑最晚读到 23:57，每天最多 3 次；补跑时需要扫码而超时，当天不再补跑。</p>
      <template v-if="view">
        <div class="grid rule-fields">
          <label>
            目标（分钟）
            <input type="number" min="1" max="1440" v-model.number="form.minutes">
          </label>
          <label>
            检查时间（HH:MM，{{ view.timezone }}）
            <input v-model.trim="form.checkAt" placeholder="22:00" inputmode="numeric">
          </label>
        </div>
        <p v-if="view.suggestedMinutes" class="muted">
          按当前挑战，平均每天约需 {{ view.suggestedMinutes }} 分钟。
          <button type="button" class="outline small" @click="useSuggested">使用建议值</button>
        </p>
        <p v-if="view.warning" class="callout callout-warn" role="note">{{ view.warning }}</p>
        <p v-if="view.goal && view.goal.enabled" class="muted">
          今天已读 {{ view.today.minutes }}/{{ view.goal.minutes }} 分钟<template v-if="view.planned">，已补跑 {{ view.planned.catchups.count }}/{{ view.planned.catchups.max }} 次<template v-if="view.planned.catchups.blocked">（今天不再补跑）</template><template v-else-if="view.planned.catchups.waitingLogin">（等扫码登录后补读）</template></template>。
        </p>
        <p v-if="error" class="error-text">{{ error }}</p>
        <p v-if="dirty" class="muted">每日目标有未保存的修改。</p>
        <div class="rule-footer">
          <label class="switch-line"><input type="checkbox" role="switch" v-model="form.enabled"> 启用</label>
          <button type="button" :aria-busy="busy" :disabled="busy" @click="save">保存目标</button>
        </div>
      </template>
    </article>`,
};

// 调度：多条规则，可单独启停；预览接下来的运行时间，保存后立即生效
export const SchedulesTab = {
  components: { GoalCard },
  props: { account: Object },
  setup(props) {
    const rules = ref([]);
    const tz = ref("");
    const nextRunAt = ref(null);
    const nextRunJitter = ref(0);
    const error = ref("");
    const busy = ref(false);
    // 上次加载或保存时的规则，用于判断是否有未保存的修改
    const saved = ref("[]");
    const snapshot = () => JSON.stringify(rules.value.map(toPayload));
    const dirty = computed(() => snapshot() !== saved.value);
    const goalDirty = ref(false);

    function apply(data) {
      rules.value = data.schedules.map(toEditable);
      saved.value = snapshot();
      tz.value = data.timezone;
      if ("nextRunAt" in data) {
        nextRunAt.value = data.nextRunAt;
        nextRunJitter.value = data.nextRunJitterMinutes || 0;
      }
    }

    async function load() {
      try {
        apply(await api(`accounts/${props.account.id}/schedules`));
      } catch (e) {
        notify(e.message, "error");
      }
    }

    async function submit(preview) {
      busy.value = true;
      error.value = "";
      try {
        const schedules = rules.value.map(toPayload);
        if (preview) {
          const data = await api("schedules/preview", { method: "POST", body: { schedules } });
          // 预览不保存：只更新说明与触发时间
          data.schedules.forEach((rule, index) => {
            Object.assign(rules.value[index], { description: rule.description, nextRuns: rule.nextRuns });
          });
        } else {
          apply(await api(`accounts/${props.account.id}/schedules`, { method: "PUT", body: { schedules } }));
          await refreshAccounts();
          notify("调度已保存，立即生效");
        }
      } catch (e) {
        error.value = e.message;
      } finally {
        busy.value = false;
      }
    }

    function add() {
      rules.value.push(toEditable({ type: "daily", times: ["06:00"], enabled: true }));
    }

    onMounted(load);
    onUnmounted(
      setLeaveGuard(() => {
        if (dirty.value) {
          return "调度规则有未保存的修改，确定离开吗？";
        }
        return goalDirty.value ? "每日目标有未保存的修改，确定离开吗？" : "";
      })
    );

    return {
      rules,
      tz,
      nextRunAt,
      nextRunJitter,
      error,
      busy,
      dirty,
      setGoalDirty: (value) => {
        goalDirty.value = value;
      },
      add,
      remove: (index) => rules.value.splice(index, 1),
      preview: () => submit(true),
      save: () => submit(false),
      formatShort,
      formatNextRun,
      timezone,
      INTERVAL_HOURS,
      SCHEDULE_TYPE_LABELS,
    };
  },
  template: `
    <section>
      <p>
        下次运行：<strong>{{ nextRunAt ? formatNextRun(nextRunAt, nextRunJitter, tz) : "未设置" }}</strong>
        <span v-if="!account.enabled" class="muted">（账号已停用，不会定时运行）</span>
      </p>
      <p class="muted">时间按 {{ tz }} 时区解释，可在“设置”中修改。账号正在运行或排队时，到点的触发会跳过；面板停机期间错过的时间，重启后在“补触发宽限时间”内的会补触发一次。</p>

      <article v-for="(rule, index) in rules" :key="rule.key" class="schedule-rule">
        <div class="grid rule-fields">
          <label>
            类型
            <select v-model="rule.type">
              <option v-for="(label, value) in SCHEDULE_TYPE_LABELS" :key="value" :value="value">{{ label }}</option>
            </select>
          </label>
          <label v-if="rule.type === 'daily'">
            时间（HH:MM，多个用逗号分隔）
            <input v-model="rule.timesText" placeholder="06:00, 18:30">
          </label>
          <template v-else-if="rule.type === 'interval'">
            <label>
              每隔
              <select v-model.number="rule.hours">
                <option v-for="hours in INTERVAL_HOURS" :key="hours" :value="hours">{{ hours }} 小时</option>
              </select>
            </label>
            <label>
              在第几分钟
              <input type="number" min="0" max="59" v-model.number="rule.minute">
            </label>
          </template>
          <label v-else>
            cron 表达式（分 时 日 月 周）
            <input v-model="rule.expression" placeholder="30 6 * * 1-5">
          </label>
          <label>
            随机延后（0–30 分钟）
            <input type="number" min="0" max="30" v-model.number="rule.jitterMinutes">
          </label>
        </div>
        <div class="rule-footer">
          <label class="switch-line"><input type="checkbox" role="switch" v-model="rule.enabled"> 启用</label>
          <button type="button" class="outline small" @click="remove(index)">删除</button>
        </div>
        <p v-if="rule.description" class="muted">
          {{ rule.description }}<template v-if="rule.nextRuns.length">：接下来 {{ rule.nextRuns.map((time) => formatShort(time, tz)).join("、") }}</template>
          <template v-else-if="!rule.enabled">（已停用）</template>
        </p>
      </article>

      <p v-if="!rules.length" class="muted">还没有调度规则。</p>
      <p v-if="error" class="error-text">{{ error }}</p>
      <div class="form-actions">
        <button type="button" class="secondary" @click="add">添加规则</button>
        <button type="button" class="secondary" :disabled="busy || !rules.length" @click="preview">预览运行时间</button>
        <button type="button" :aria-busy="busy" :disabled="busy" @click="save">保存</button>
      </div>
      <p v-if="dirty" class="muted">有未保存的修改。</p>

      <goal-card :account="account" @dirty-change="setGoalDirty" />
    </section>`,
};
