import { computed, reactive, ref } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { ReauthCancelled, withReauth } from "./reauth-dialog.js";
import { formatDateTime } from "../format.js";
import { notify, refreshAccounts, refreshSettings, state, timezone } from "../store.js";

const MIN_PASSPHRASE = 8;
const ACTION_LABELS = { add: "新增", overwrite: "覆盖", skip: "跳过" };

// 设置页的“备份与迁移”：导出配置备份（可选加密的密钥与登录状态），导入时先预览再确认。
// 页面中需要有 <reauth-dialog>（设置页已有），导出与导入都要求近期验证过身份
export const BackupPanel = {
  setup() {
    const exportForm = reactive({ includeSecrets: false, includeCookies: false, passphrase: "", confirm: "" });
    const exporting = ref(false);
    const needsPassphrase = computed(() => exportForm.includeSecrets || exportForm.includeCookies);

    const importForm = reactive({ fileName: "", backup: null, passphrase: "", accounts: "merge", overwrite: false, settings: true });
    const preview = ref(null);
    const previewing = ref(false);
    const applying = ref(false);
    const fileError = ref("");

    const fieldLabels = computed(() => Object.fromEntries((state.schema.fields || []).map((field) => [field.key, field.label])));
    const settingLabels = computed(() => Object.fromEntries((state.schema.settingsFields || []).map((field) => [field.key, field.label])));
    const accountName = (id) => (id === "defaults" ? "全局默认配置" : `账号 ${id}`);

    function download(backup) {
      const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `weread-assistant-backup-${String(backup.exportedAt || "").slice(0, 10).replace(/-/g, "")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function exportBackup() {
      if (needsPassphrase.value) {
        if (exportForm.passphrase.length < MIN_PASSPHRASE) {
          notify(`备份密码至少 ${MIN_PASSPHRASE} 位`, "error");
          return;
        }
        if (exportForm.passphrase !== exportForm.confirm) {
          notify("两次输入的备份密码不一致", "error");
          return;
        }
      }
      exporting.value = true;
      try {
        const body = { includeSecrets: exportForm.includeSecrets, includeCookies: exportForm.includeCookies };
        if (needsPassphrase.value) {
          body.passphrase = exportForm.passphrase;
        }
        const backup = await withReauth(() => api("backup/export", { method: "POST", body }));
        download(backup);
        exportForm.passphrase = "";
        exportForm.confirm = "";
        notify(backup.omittedSecrets.length ? `已导出，不含 ${backup.omittedSecrets.length} 项密钥，导入后需要重新填写` : "已导出");
      } catch (error) {
        if (!(error instanceof ReauthCancelled)) {
          notify(error.message, "error");
        }
      } finally {
        exporting.value = false;
      }
    }

    function chooseFile(event) {
      const [file] = event.target.files;
      importForm.backup = null;
      importForm.fileName = "";
      preview.value = null;
      fileError.value = "";
      if (!file) {
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        fileError.value = "文件超过 2MB，不是面板导出的备份文件";
        return;
      }
      file.text().then(
        (text) => {
          try {
            const backup = JSON.parse(text);
            if (!backup || backup.format !== "weread-assistant-backup") {
              throw new Error("format");
            }
            importForm.backup = backup;
            importForm.fileName = file.name;
          } catch (_) {
            fileError.value = "不是 WeReadAssistant 的备份文件";
          }
        },
        () => {
          fileError.value = "读取文件失败";
        }
      );
    }

    function requestBody(mode) {
      const body = {
        mode,
        backup: importForm.backup,
        options: { accounts: importForm.accounts, overwrite: importForm.overwrite, settings: importForm.settings },
      };
      if (importForm.backup && importForm.backup.sealed) {
        body.passphrase = importForm.passphrase;
      }
      return body;
    }

    async function previewImport() {
      previewing.value = true;
      preview.value = null;
      try {
        preview.value = (await withReauth(() => api("backup/import", { method: "POST", body: requestBody("preview") }))).preview;
      } catch (error) {
        if (!(error instanceof ReauthCancelled)) {
          notify(error.message, "error");
        }
      } finally {
        previewing.value = false;
      }
    }

    async function applyImport() {
      if (!window.confirm("确定按预览导入？导入前的 panel.json 会另存一份，导入错了可以从数据目录中找回。")) {
        return;
      }
      applying.value = true;
      try {
        const result = await withReauth(() => api("backup/import", { method: "POST", body: requestBody("apply") }));
        preview.value = null;
        importForm.backup = null;
        importForm.fileName = "";
        importForm.passphrase = "";
        await Promise.all([refreshSettings(), refreshAccounts()]);
        notify(`导入完成，导入前的配置另存为 ${result.copy}`);
      } catch (error) {
        if (!(error instanceof ReauthCancelled)) {
          notify(error.message, "error");
        }
      } finally {
        applying.value = false;
      }
    }

    // 预览中一项变化的显示文字
    const describeValue = (value) => (value === null || value === undefined || value === "" ? "（空）" : String(value));

    return {
      exportForm,
      exporting,
      needsPassphrase,
      exportBackup,
      importForm,
      preview,
      previewing,
      applying,
      fileError,
      chooseFile,
      previewImport,
      applyImport,
      fieldLabels,
      settingLabels,
      accountName,
      describeValue,
      formatDateTime,
      timezone,
      ACTION_LABELS,
    };
  },
  template: `
    <div class="backup-panel">
      <h4>导出</h4>
      <p class="muted">导出面板设置、全局默认配置、账号与调度规则、挑战与每日目标。不包含面板密码、passkey、运行记录与截图。</p>
      <form class="narrow" @submit.prevent="exportBackup">
        <label class="switch-line"><input type="checkbox" v-model="exportForm.includeSecrets"> 包含密钥（Bark Key、ntfy 主题、SMTP 密码、Webhook 地址、Telegram 令牌等）</label>
        <label class="switch-line"><input type="checkbox" v-model="exportForm.includeCookies"> 包含各账号的登录状态（cookies），恢复后不用重新扫码</label>
        <template v-if="needsPassphrase">
          <label>备份密码<input type="password" v-model="exportForm.passphrase" autocomplete="new-password" minlength="8" required></label>
          <label>再次输入备份密码<input type="password" v-model="exportForm.confirm" autocomplete="new-password" minlength="8" required></label>
          <small class="muted">密钥与登录状态用这个密码加密，导入时需要输入。忘记密码就无法恢复这两部分。</small>
        </template>
        <button type="submit" :aria-busy="exporting" :disabled="exporting">导出备份</button>
      </form>

      <h4>导入</h4>
      <p class="muted">先预览将要发生的变化，确认后才写入。正在运行的账号不会被覆盖。</p>
      <div class="narrow">
        <label>备份文件<input type="file" accept=".json,application/json" @change="chooseFile"></label>
        <p v-if="fileError" class="error-text">{{ fileError }}</p>
        <template v-if="importForm.backup">
          <p class="muted">
            {{ importForm.fileName }}：{{ importForm.backup.appVersion ? 'v' + importForm.backup.appVersion + ' ' : '' }}于 {{ formatDateTime(importForm.backup.exportedAt, timezone()) }} 导出，
            {{ (importForm.backup.accounts || []).length }} 个账号{{ importForm.backup.sealed ? '，含加密的密钥或登录状态' : '' }}
          </p>
          <label v-if="importForm.backup.sealed">备份密码<input type="password" v-model="importForm.passphrase" autocomplete="off" required></label>
          <fieldset>
            <legend>账号</legend>
            <label class="switch-line"><input type="radio" value="merge" v-model="importForm.accounts"> 合并：保留现有账号，加入备份中的账号</label>
            <label v-if="importForm.accounts === 'merge'" class="switch-line indent"><input type="checkbox" v-model="importForm.overwrite"> 覆盖同 ID 的现有账号</label>
            <label class="switch-line"><input type="radio" value="replace" v-model="importForm.accounts"> 整体替换：备份中没有的账号从面板移除（保留数据目录）</label>
          </fieldset>
          <label class="switch-line"><input type="checkbox" v-model="importForm.settings"> 同时导入面板设置与全局默认配置</label>
          <button type="button" class="secondary" :aria-busy="previewing" :disabled="previewing" @click="previewImport">预览</button>
        </template>
      </div>

      <div v-if="preview" class="backup-preview">
        <h5>预览</h5>
        <div v-if="preview.accounts.length" class="table-scroll">
          <table class="striped">
            <thead><tr><th>账号</th><th>操作</th><th>登录状态</th></tr></thead>
            <tbody>
              <tr v-for="entry in preview.accounts" :key="entry.id">
                <td>{{ entry.name }}（{{ entry.id }}）</td>
                <td>{{ ACTION_LABELS[entry.action] || entry.action }}<small v-if="entry.reason" class="muted">：{{ entry.reason }}</small></td>
                <td>{{ entry.cookies ? '导入' : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">备份中没有可导入的账号。</p>
        <p v-if="preview.removed.length">将从面板移除：{{ preview.removed.map((item) => item.name + '（' + item.id + '）').join('、') }}</p>
        <p v-for="item in preview.kept" :key="item.id" class="muted">保留 {{ item.name }}（{{ item.id }}）：{{ item.reason }}</p>
        <template v-if="preview.settings.length || preview.defaults.length">
          <p>设置的变化：</p>
          <ul>
            <li v-for="item in preview.settings" :key="'s-' + item.key">{{ settingLabels[item.key] || item.key }}：{{ describeValue(item.from) }} → {{ describeValue(item.to) }}</li>
            <li v-for="item in preview.defaults" :key="'d-' + item.key">全局默认 · {{ fieldLabels[item.key] || item.key }}：{{ describeValue(item.from) }} → {{ describeValue(item.to) }}</li>
          </ul>
        </template>
        <p v-if="preview.omittedSecrets.length" class="callout callout-warn">
          备份中不含这些密钥，导入后需要重新填写（同 ID 账号与全局默认中已有的密钥会保留）：
          {{ preview.omittedSecrets.map((item) => accountName(item.scope) + ' · ' + (fieldLabels[item.key] || item.key)).join('、') }}
        </p>
        <template v-if="preview.invalid.length">
          <p class="error-text">以下条目无效，不会导入：</p>
          <ul>
            <li v-for="(item, index) in preview.invalid" :key="index">{{ item.item }}：{{ item.reason }}</li>
          </ul>
        </template>
        <button type="button" :aria-busy="applying" :disabled="applying" @click="applyImport">确认导入</button>
      </div>
    </div>`,
};
