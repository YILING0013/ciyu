import { useState } from "react";
import Icon from "./ui-icon";
import { serializePrompt } from "./prompt";

/**
 * 在收藏中浏览保存的提示词笔记并导入独立副本。
 * @param {object} props 笔记列表、搜索词以及导入和删除操作。
 * @returns {React.ReactNode} 左侧索引与右侧正文。
 */
export default function PromptNotes({ notes, query, onImport, onRemove }) {
  const [selectedId, setSelectedId] = useState(null);
  const terms = query.trim().normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = terms.length ? notes.filter((note) => {
    const words = [note.title, ...note.entries.flatMap((entry) =>
      entry.type === "group"
        ? [entry.name, ...entry.items.flatMap((tag) => [tag.name, tag.cn])]
        : [entry.name, entry.cn])];
    const text = words.join("\n").normalize("NFKC").toLowerCase();
    return terms.every((term) => text.includes(term));
  }) : notes;
  const selected = matches.find((note) => note.id === selectedId) || matches[0];

  if (!selected) return (
    <p className="empty-state">
      {terms.length ? "没有匹配的提示词笔记" : "在选择区点击「收藏为笔记」，就能在这里找到整份提示词。"}
    </p>
  );

  return (
    <section className="prompt-notebook" aria-label="提示词笔记">
      <nav className="notebook-index" aria-label="笔记列表">
        <header>笔记 <span>{matches.length}</span></header>
        <div className="notebook-items">
          {matches.map((note) => (
            <button key={note.id} aria-current={selected.id === note.id ? "true" : undefined}
              onClick={() => setSelectedId(note.id)} title={note.title}>{note.title}</button>
          ))}
        </div>
      </nav>
      <article className="notebook-content">
        <div className="note-header">
          <div>
            <h2>{selected.title}</h2>
            <span>{selected.format === "sd" ? "Stable Diffusion" : "NovelAI"}</span>
          </div>
          <div className="note-actions">
            <button className="secondary-button" onClick={() => onImport(selected)}>
              <Icon name="plus" />导入到选择区
            </button>
            <button className="icon-button" aria-label={`删除笔记 ${selected.title}`} onClick={() => {
              if (window.confirm(`删除提示词笔记「${selected.title}」？`)) onRemove(selected.id);
            }}><Icon name="trash" /></button>
          </div>
        </div>
        <pre className="note-preview">{serializePrompt(selected.entries, selected.format)}</pre>
      </article>
    </section>
  );
}
