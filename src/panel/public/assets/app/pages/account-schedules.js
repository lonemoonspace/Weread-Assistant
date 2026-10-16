import { onMounted, ref } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { SCHEDULE_TYPE_LABELS, formatShort } from "../format.js";
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
    description: rule.description || "",
    nextRuns: rule.nextRuns || [],
  };
}

function toPayload(rule) {
  const base = { id: rule.id || undefined, type: rule.type, enabled: rule.enabled };
  if (rule.type === "daily") {
    return { ...base, times: rule.timesText.split(/[\s,，、]+/).filter(Boolean) };
  }
  if (rule.type === "interval") {
    return { ...base, hours: Number(rule.hours), minute: Number(rule.minute) };
  }
  return { ...base, expression: rule.expression };
}

// 调度：多条规则，可单独启停；预览接下来的运行时间，保存后立即生效
export const SchedulesTab = {
  props: { account: Object },
  setup(props) {
    const rules = ref([]);
    const tz = ref("");
    const nextRunAt = ref(null);
    const error = ref("");
    const busy = ref(false);

    function apply(data) {
      rules.value = data.schedules.map(toEditable);
      tz.value = data.timezone;
      if ("nextRunAt" in data) {
        nextRunAt.value = data.nextRunAt;
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

    return {
      rules,
      tz,
      nextRunAt,
      error,
      busy,
      add,
      remove: (index) => rules.value.splice(index, 1),
      preview: () => submit(true),
      save: () => submit(false),
      formatShort,
      timezone,
      INTERVAL_HOURS,
      SCHEDULE_TYPE_LABELS,
    };
  },
  template: `
    <section>
      <p>
        下次运行：<strong>{{ nextRunAt ? formatShort(nextRunAt, tz) : "未设置" }}</strong>
        <span v-if="!account.enabled" class="muted">（账号已停用，不会定时运行）</span>
      </p>
      <p class="muted">时间按 {{ tz }} 时区解释，可在“设置”中修改。账号正在运行或排队时，到点的触发会跳过；面板停机期间错过的时间不补跑。</p>

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
    </section>`,
};
