import { useState } from "react";
import Icon from "./ui-icon";
import PromptLabel from "./prompt-label";
import { accents, defaultPreferences, densities, editorLabels, parseBackup, schemes, serializeBackup } from "./workspace-storage";

/**
 * 提供外观和浏览设置，改动即时应用到词库。
 * @param {object} props 当前偏好、展示形式及对应更新回调。
 * @returns {React.ReactNode} 设置页面。
 */
export default function Preferences({ workspace, ready, storageError, onChange, onRestore, onClose }) {
  const [busy, setBusy] = useState(false);
  const [backupError, setBackupError] = useState("");
  const { preferences: values, view } = workspace;
  return (
    <main className="settings-page" id="main">
      <div className="settings-heading">
        <div>
          <h1>设置</h1>
          <p>更改即时生效，并保存在当前浏览器。</p>
        </div>
        <div className="settings-heading-actions">
          <button className="secondary-button" onClick={() => onChange({ preferences: defaultPreferences, view: "pills" })}>
            恢复默认设置
          </button>
          <button className="secondary-button" onClick={onClose}>返回词库</button>
        </div>
      </div>
      <section className="settings-card" aria-labelledby="appearance-settings">
        <h2 id="appearance-settings">外观</h2>
        {[
          { field: "scheme", label: "配色模式", options: schemes },
          { field: "accent", label: "主题色", options: accents },
          { field: "density", label: "结果标签大小", options: densities, help: "调整词库胶囊和表格的字号与间距。" },
          { field: "editorDensity", label: "提示词标签大小", options: densities, help: "调整选择区的标签和组内成员。" },
          { field: "editorLabel", label: "提示词标签语言", options: editorLabels, help: "缺少中文译名时显示英文原名。" },
        ].map(({ field, label, options, help }) => (
          <div className="settings-row" key={field}>
            <div>
              <span id={`setting-${field}`}>{label}</span>
              {help && <p>{help}</p>}
            </div>
            <div className="settings-options" role="group" aria-labelledby={`setting-${field}`}>
              {Object.entries(options).map(([value, name]) => (
                <button key={value} aria-pressed={values[field] === value}
                  onClick={() => onChange({ preferences: { ...values, [field]: value } })}>
                  {field === "accent" && <span className="theme-swatch" data-color={value} />}
                  {name}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="density-preview" aria-hidden="true">
          <div className="tag-waterfall">
            <span className="preview-label">词库</span>
            <div className="tag-pill">
              <span className="tag-identity">
                <span className="tag-name">soft_lighting</span>
                <span className="tag-cn">柔和光照</span>
              </span>
            </div>
          </div>
          <div className="editor-density-preview" data-editor-density={values.editorDensity}>
            <span className="preview-label">选择区</span>
            <div className="prompt-entry">
              <div className="prompt-entry-main">
                <PromptLabel cn="柔和光照" name="soft_lighting" mode={values.editorLabel} />
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="settings-card" aria-labelledby="browse-settings">
        <h2 id="browse-settings">浏览</h2>
        <div className="settings-row">
          <span id="setting-view">标签视图</span>
          <div className="settings-options" role="group" aria-labelledby="setting-view">
            <button aria-pressed={view === "pills"} onClick={() => onChange({ view: "pills" })}>
              <Icon name="pill" />胶囊
            </button>
            <button aria-pressed={view === "table"} onClick={() => onChange({ view: "table" })}>
              <Icon name="table" />表格
            </button>
          </div>
        </div>
        <label className="settings-row">
          <span>
            自动折叠其他类别
            <span className="setting-description">展开一个类别时，收起侧栏中其他已展开的类别。</span>
          </span>
          <input type="checkbox" checked={values.accordion}
            onChange={(event) => onChange({ preferences: { ...values, accordion: event.target.checked } })} />
        </label>
        <label className="settings-row">
          <span>显示搜索联想</span>
          <input type="checkbox" checked={values.suggestions}
            onChange={(event) => onChange({ preferences: { ...values, suggestions: event.target.checked } })} />
        </label>
      </section>
      <section className="settings-card" aria-labelledby="backup-settings">
        <h2 id="backup-settings">备份与恢复</h2>
        <p className="setting-description">导出收藏标签、提示词草稿、笔记和界面设置。导入备份会替换当前个人数据。</p>
        {storageError && <p role="alert" className="backup-error">{storageError}</p>}
        {backupError && <p role="alert" className="backup-error">{backupError}</p>}
        <div className="backup-actions">
          <button className="secondary-button" disabled={!ready || busy} onClick={() => {
            const url = URL.createObjectURL(new Blob([serializeBackup(workspace)], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = `tag-atlas-backup-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>
            导出数据
          </button>
          <label className="backup-import">
            <span className="secondary-button">导入数据</span>
            <input type="file" aria-label="导入数据" accept=".json,application/json" disabled={!ready || busy}
              onChange={async (event) => {
                const input = event.currentTarget;
                const file = input.files[0];
                input.value = "";
                if (!file) return;
                setBusy(true);
                setBackupError("");
                try {
                  const data = parseBackup(await file.text());
                  if (window.confirm("恢复此备份会替换当前的收藏、提示词草稿、笔记和界面设置。要继续吗？")) {
                    await onRestore(data);
                  }
                } catch (error) {
                  setBackupError(error instanceof SyntaxError ? "备份文件不是有效的 JSON" : error.message);
                } finally {
                  setBusy(false);
                }
              }} />
          </label>
        </div>
      </section>
    </main>
  );
}
