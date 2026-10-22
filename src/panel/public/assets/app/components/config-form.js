import { computed, reactive, ref, watch } from "../../vendor/vue.esm-browser.prod.js";

// 运行配置表单，由 api/schema 生成。
// mode = "defaults"：全局默认配置，未填写的项使用内置默认值；
// mode = "overrides"：账号覆盖，每项可选择继承全局或单独设置。
// 密钥只写不读：接口返回掩码，留空表示不修改，点“清除”删除
const SECRET_MASK = "••••••";

function display(field, value) {
  if (field.secret) {
    return value ? "已设置" : "未设置";
  }
  if (field.type === "boolean") {
    return value ? "开启" : "关闭";
  }
  if (field.options) {
    const option = field.options.find((item) => item.value === value);
    return option ? option.label : String(value);
  }
  return value === "" || value === undefined || value === null ? "（空）" : String(value);
}

export const ConfigForm = {
  props: {
    schema: Object,
    values: Object,
    // overrides 模式下各项继承的值（全局默认或内置默认）
    inherited: Object,
    mode: { type: String, default: "defaults" },
    saving: Boolean,
  },
  emits: ["save"],
  setup(props, { emit }) {
    const draft = reactive({});
    const override = reactive({});
    const cleared = reactive({});
    const error = ref("");

    function reset() {
      error.value = "";
      for (const field of props.schema.fields) {
        const has = Object.prototype.hasOwnProperty.call(props.values, field.key);
        const value = has ? props.values[field.key] : field.default;
        override[field.key] = has;
        cleared[field.key] = false;
        if (field.secret) {
          draft[field.key] = "";
        } else if (field.type === "boolean") {
          draft[field.key] = Boolean(has ? value : props.mode === "overrides" ? props.inherited[field.key] : field.default);
        } else if (props.mode === "overrides" && !has) {
          draft[field.key] = props.inherited[field.key] === undefined ? "" : props.inherited[field.key];
        } else {
          draft[field.key] = has ? value : "";
        }
      }
    }
    reset();
    // 运行状态变化时账号列表会整体刷新，values 换成内容相同的新对象；只有内容确实变了（例如保存后）才重置，
    // 否则正在编辑、尚未保存的输入会被清掉
    watch(() => JSON.stringify(props.values), reset);

    const groups = computed(() =>
      props.schema.groups.map((group) => ({
        ...group,
        fields: props.schema.fields.filter((field) => field.group === group.id),
      }))
    );

    function isSet(field) {
      return props.values[field.key] === SECRET_MASK;
    }

    // 只提交有变化的项；null 表示删除该项（回到上一级的值）
    function patch() {
      const result = {};
      for (const field of props.schema.fields) {
        const key = field.key;
        const has = Object.prototype.hasOwnProperty.call(props.values, key);
        if (props.mode === "overrides" && !override[key]) {
          if (has) {
            result[key] = null;
          }
          continue;
        }
        if (field.secret) {
          if (cleared[key]) {
            result[key] = null;
          } else if (draft[key] !== "") {
            result[key] = draft[key];
          } else if (props.mode === "overrides" && !has) {
            throw new Error(`请填写“${field.label}”，或改为继承全局`);
          }
          continue;
        }
        const value = draft[key];
        if (props.mode === "defaults") {
          if (field.type !== "boolean" && value === "") {
            if (has) {
              result[key] = null;
            }
            continue;
          }
          // 未设置的项与内置默认值（开关）或空值（其他）比较，没有变化就不提交
          const baseline = has ? props.values[key] : field.type === "boolean" ? field.default : "";
          if (value !== baseline) {
            result[key] = value;
          }
          continue;
        }
        if (!has || value !== props.values[key]) {
          result[key] = value;
        }
      }
      return result;
    }

    function submit() {
      error.value = "";
      try {
        emit("save", patch());
      } catch (e) {
        error.value = e.message;
      }
    }

    return { draft, override, cleared, groups, error, isSet, submit, reset, display };
  },
  template: `
    <form class="config-form" @submit.prevent="submit">
      <details v-for="(group, index) in groups" :key="group.id" :open="index === 0">
        <summary>{{ group.label }}</summary>
        <div v-for="field in group.fields" :key="field.key" class="field">
          <div class="field-head">
            <label :for="'f-' + field.key">{{ field.label }}</label>
            <label v-if="mode === 'overrides'" class="override-toggle">
              <input type="checkbox" role="switch" v-model="override[field.key]"> 单独设置
            </label>
          </div>
          <p v-if="mode === 'overrides' && !override[field.key]" class="muted inherited">
            继承：{{ display(field, inherited[field.key]) }}
          </p>
          <template v-else>
            <select v-if="field.options" :id="'f-' + field.key" v-model="draft[field.key]">
              <option v-if="mode === 'defaults'" value="">默认（{{ display(field, field.default) }}）</option>
              <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <label v-else-if="field.type === 'boolean'" class="switch-line">
              <input :id="'f-' + field.key" type="checkbox" role="switch" v-model="draft[field.key]"> {{ draft[field.key] ? "开启" : "关闭" }}
            </label>
            <div v-else-if="field.secret" class="secret">
              <input
                :id="'f-' + field.key"
                type="password"
                autocomplete="new-password"
                v-model="draft[field.key]"
                :disabled="cleared[field.key]"
                :placeholder="cleared[field.key] ? '保存后清除' : isSet(field) ? '已设置，留空不修改' : '未设置'"
              >
              <button v-if="isSet(field)" type="button" class="outline small" @click="cleared[field.key] = !cleared[field.key]">
                {{ cleared[field.key] ? "撤销清除" : "清除" }}
              </button>
            </div>
            <input
              v-else-if="field.type === 'integer'"
              :id="'f-' + field.key"
              type="number"
              step="1"
              :min="field.min ?? undefined"
              :max="field.max ?? undefined"
              v-model.number="draft[field.key]"
              :placeholder="mode === 'defaults' ? '默认 ' + field.default : ''"
            >
            <input
              v-else
              :id="'f-' + field.key"
              type="text"
              v-model.trim="draft[field.key]"
              :placeholder="mode === 'defaults' && field.default ? '默认 ' + field.default : ''"
            >
          </template>
          <small v-if="field.description" class="muted">{{ field.description }}</small>
        </div>
      </details>
      <p v-if="error" class="error-text">{{ error }}</p>
      <div class="form-actions">
        <button type="submit" :aria-busy="saving" :disabled="saving">保存配置</button>
        <button type="button" class="secondary" @click="reset">撤销修改</button>
      </div>
    </form>`,
};
