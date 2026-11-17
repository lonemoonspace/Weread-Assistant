import { computed, onMounted, reactive, ref } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { ConfigForm } from "../components/config-form.js";
import { TestNotification } from "../components/test-notification.js";
import { formatBytes } from "../format.js";
import { go } from "../router.js";
import { notify, refreshAccounts, state } from "../store.js";

// 配置：账号名称与启用状态、运行配置（继承全局或单独设置）、测试通知、浏览器资料、删除账号
export const ConfigTab = {
  components: { ConfigForm, TestNotification },
  props: { account: Object },
  setup(props) {
    const info = reactive({ name: props.account.name, enabled: props.account.enabled });
    const savingInfo = ref(false);
    const savingConfig = ref(false);
    const deleteData = ref(false);
    const deleting = ref(false);
    // 内置浏览器的资料目录：null 表示还没有读到
    const profile = ref(null);
    const resettingProfile = ref(false);
    // 测试微信读书 API Key 的结果
    const officialTest = ref(null);
    const testingOfficial = ref(false);
    const hasApiKey = computed(() => Boolean(props.account.overrides && props.account.overrides.wereadApiKey));

    async function testOfficial() {
      testingOfficial.value = true;
      officialTest.value = null;
      try {
        officialTest.value = await api(`accounts/${props.account.id}/official/test`, { method: "POST", body: {} });
      } catch (error) {
        officialTest.value = { ok: false, error: error.message };
      } finally {
        testingOfficial.value = false;
      }
    }

    // 继承的值：全局默认，未设置时为内置默认
    const inherited = computed(() =>
      Object.fromEntries(
        state.schema.fields.map((field) => [
          field.key,
          Object.prototype.hasOwnProperty.call(state.defaults, field.key) ? state.defaults[field.key] : field.default,
        ])
      )
    );

    async function update(body, message) {
      await api(`accounts/${props.account.id}`, { method: "PATCH", body });
      await refreshAccounts();
      notify(message);
    }

    async function saveInfo() {
      if (savingInfo.value) {
        return;
      }
      savingInfo.value = true;
      try {
        await update({ name: info.name, enabled: info.enabled }, "已保存");
      } catch (error) {
        notify(error.message, "error");
      } finally {
        savingInfo.value = false;
      }
    }

    async function saveConfig(patch) {
      if (!Object.keys(patch).length) {
        notify("没有需要保存的修改");
        return;
      }
      savingConfig.value = true;
      try {
        await update({ overrides: patch }, "运行配置已保存，下次运行生效");
      } catch (error) {
        notify(error.message, "error");
      } finally {
        savingConfig.value = false;
      }
    }

    async function remove() {
      const text = deleteData.value
        ? `确定删除账号“${props.account.name}”，并删除它的 cookies、截图与运行记录？此操作不能撤销。`
        : `确定从面板移除账号“${props.account.name}”？数据目录会保留，重新添加同 ID 的账号时继续使用。`;
      if (deleting.value || !window.confirm(text)) {
        return;
      }
      deleting.value = true;
      try {
        await api(`accounts/${props.account.id}`, { method: "DELETE", body: { deleteData: deleteData.value } });
        await refreshAccounts();
        notify("账号已删除");
        go("/");
      } catch (error) {
        notify(error.message, "error");
      } finally {
        deleting.value = false;
      }
    }

    async function loadProfile() {
      try {
        profile.value = (await api(`accounts/${props.account.id}`)).profile || null;
      } catch (_) {
        profile.value = null;
      }
    }

    async function resetProfile() {
      const text = "确定重置浏览器资料？页面缓存、本地存储与浏览器中的登录状态会被删除，下次运行从 cookies.json 恢复登录。";
      if (resettingProfile.value || !window.confirm(text)) {
        return;
      }
      resettingProfile.value = true;
      try {
        profile.value = (await api(`accounts/${props.account.id}/profile`, { method: "DELETE" })).profile;
        notify("浏览器资料已重置");
      } catch (error) {
        notify(error.message, "error");
      } finally {
        resettingProfile.value = false;
      }
    }

    onMounted(() => {
      info.name = props.account.name;
      info.enabled = props.account.enabled;
      loadProfile();
    });

    return {
      info,
      savingInfo,
      savingConfig,
      deleteData,
      deleting,
      inherited,
      profile,
      resettingProfile,
      officialTest,
      testingOfficial,
      hasApiKey,
      testOfficial,
      formatBytes,
      saveInfo,
      saveConfig,
      remove,
      resetProfile,
      state,
    };
  },
  template: `
    <section>
      <h3>账号</h3>
      <form class="grid" @submit.prevent="saveInfo">
        <label>名称<input v-model.trim="info.name" maxlength="32" required></label>
        <label class="switch-line">
          <input type="checkbox" role="switch" v-model="info.enabled"> 启用（停用后不会定时运行，也不能手动运行）
        </label>
        <div class="form-actions"><button type="submit" :aria-busy="savingInfo" :disabled="savingInfo">保存</button></div>
      </form>
    </section>

    <section>
      <h3>运行配置</h3>
      <p class="muted">未单独设置的项继承“设置”中的全局默认配置。</p>
      <config-form
        mode="overrides"
        :schema="state.schema"
        :values="account.overrides"
        :inherited="inherited"
        :saving="savingConfig"
        @save="saveConfig"
      />
    </section>

    <section>
      <h3>测试通知</h3>
      <test-notification :account-id="account.id" />
    </section>

    <section>
      <h3>微信读书 API</h3>
      <p class="muted">
        在上面的“微信读书 API”分组中填写本人的 API Key 后，可以同步笔记与划线、读取阅读统计。API Key 在电脑浏览器登录微信读书网页版后，打开
        <a href="https://weread.qq.com/r/weread-skills" target="_blank" rel="noopener noreferrer">weread.qq.com/r/weread-skills</a> 获取，只发给微信读书。
      </p>
      <button type="button" class="secondary" :aria-busy="testingOfficial" :disabled="testingOfficial || !hasApiKey" @click="testOfficial">测试 API Key</button>
      <p v-if="!hasApiKey" class="muted">还没有填写 API Key。</p>
      <p v-if="officialTest && officialTest.ok" class="muted">
        可以使用：有笔记的书 {{ officialTest.totalBookCount }} 本，笔记 {{ officialTest.totalNoteCount }} 条。<template v-if="officialTest.upgradeInfo">（{{ officialTest.upgradeInfo }}）</template>
      </p>
      <p v-else-if="officialTest" class="error-text">{{ officialTest.error }}</p>
    </section>

    <section>
      <h3>浏览器资料</h3>
      <p class="muted">使用内置浏览器并打开“保留浏览器资料”时，页面缓存、本地存储与登录状态跨运行保留，超过 300 MB 时在运行开始前清空缓存。页面反复加载失败或登录异常时可以重置。</p>
      <p v-if="profile">
        <template v-if="profile.exists">当前占用 {{ formatBytes(profile.bytes) }}<template v-if="profile.broken">（含重置时留下的旧资料）</template></template>
        <template v-else-if="profile.broken">只有重置时留下的旧资料，占用 {{ formatBytes(profile.bytes) }}</template>
        <template v-else>还没有浏览器资料（第一次用内置浏览器运行时创建）</template>
      </p>
      <button
        type="button"
        class="secondary"
        :aria-busy="resettingProfile"
        :disabled="resettingProfile || !profile || !(profile.exists || profile.broken)"
        @click="resetProfile"
      >重置浏览器资料</button>
    </section>

    <section class="danger-zone">
      <h3>删除账号</h3>
      <label class="switch-line"><input type="checkbox" v-model="deleteData"> 同时删除 cookies、截图与运行记录</label>
      <button type="button" class="contrast" :aria-busy="deleting" :disabled="deleting" @click="remove">删除账号</button>
    </section>`,
};
