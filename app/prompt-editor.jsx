"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Icon from "./ui-icon";
import PromptLabel from "./prompt-label";
import {
  dropPrompt,
  mergePrompts,
  movePrompt,
  serializePrompt,
  ungroupPrompt,
} from "./prompt";

/**
 * 将上下调权箭头和数字框放在标签文字两侧，顶层标签与组内成员共用。
 * @param {object} props 词条、标签内容与权重更新回调。
 * @returns {React.ReactNode} 权重箭头、标签内容与数字框。
 */
function WeightControl({ entry, label = entry.name, onChange, children }) {
  return (
    <>
      <div className="weight-stepper">
        <button
          aria-label={`提高 ${label} 权重`}
          onClick={() => onChange(Number((entry.weight + 0.1).toFixed(4)))}
        >
          <Icon name="up" />
        </button>
        <button
          aria-label={`降低 ${label} 权重`}
          onClick={() => onChange(Number((entry.weight - 0.1).toFixed(4)))}
        >
          <Icon name="down" />
        </button>
      </div>
      {children}
      <input
        className="weight-input"
        key={entry.weight}
        type="number"
        step="0.1"
        aria-label={`${label} 权重`}
        defaultValue={entry.weight}
        onBlur={(event) => {
          const value = event.target.valueAsNumber;
          if (!Number.isFinite(value)) event.target.value = entry.weight;
          else if (value !== entry.weight) onChange(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </>
  );
}

/**
 * 将提示词排成紧凑标签，间隙排序、中央合并，展开后编辑组成员。
 * @param {object} props 提示词、格式及修改与复制回调。
 * @returns {React.ReactNode} 位于浏览结果上方的提示词编辑区。
 */
export default function PromptEditor({
  entries,
  onChange,
  format,
  onFormatChange,
  onCopy,
  density,
  labelMode,
  onSave,
}) {
  const [checked, setChecked] = useState([]);
  const [multiSelect, setMultiSelect] = useState(false);
  const [expanded, setExpanded] = useState([]);
  const [drag, setDrag] = useState(null);
  const [undo, setUndo] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const pointerDrag = useRef(null);
  const suppressClick = useRef(false);
  const previousPositions = useRef(null);
  const markerPosition = useRef(null);
  const list = useRef(null);
  const noteDialog = useRef(null);
  const selectedIds = checked.filter((id) =>
    entries.some((entry) => entry.id === id),
  );
  const output = serializePrompt(entries, format);
  const count = entries.reduce(
    (total, entry) => total + (entry.type === "group" ? entry.items.length : 1),
    0,
  );
  const showMarker = drag?.target && drag.target.placement !== "merge";

  useLayoutEffect(() => {
    const previous = previousPositions.current;
    previousPositions.current = null;
    if (!previous || !list.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const element of list.current.querySelectorAll("[data-prompt-id]")) {
      const before = previous.get(element.dataset.promptId);
      if (!before) continue;
      // 落位后从原位置移动到新位置，连续调整时接续当前动画位置。
      element.getAnimations().forEach((animation) => animation.cancel());
      const after = element.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx || dy) element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: 185, easing: "cubic-bezier(.2,.7,.25,1)" },
      );
    }
  });

  function capturePositions() {
    previousPositions.current = new Map(
      Array.from(list.current.querySelectorAll("[data-prompt-id]"), (element) =>
        [element.dataset.promptId, element.getBoundingClientRect()]),
    );
  }

  /**
   * 从真实标签边界识别落点，换行间隙也能选择前后插入位置。
   * @param {number} x 屏幕横坐标。
   * @param {number} y 屏幕纵坐标。
   * @returns {object|null} 目标 ID 与插入或合并方式。
   */
  function locateDrop(x, y) {
    const bounds = list.current.getBoundingClientRect();
    if (
      x < bounds.left ||
      x > bounds.right ||
      y < bounds.top ||
      y > bounds.bottom
    )
      return null;
    let closest = null;
    let distance = Infinity;
    for (const element of list.current.querySelectorAll(
      ":scope > .prompt-entry",
    )) {
      // 用布局坐标命中标签，避免落位动画改变下一次拖动的落点。
      const left = bounds.left + list.current.clientLeft + element.offsetLeft - list.current.scrollLeft;
      const top = bounds.top + list.current.clientTop + element.offsetTop - list.current.scrollTop;
      const right = left + element.offsetWidth;
      const bottom = top + element.offsetHeight;
      const dx = Math.max(left - x, 0, x - right);
      const dy = Math.max(top - y, 0, y - bottom);
      const next = dx * dx + dy * dy;
      if (next >= distance) continue;
      distance = next;
      // 标签边缘和行间空隙用于插入，标签中央用于合并。
      const placement =
        y < top
          ? "before"
          : y > bottom
            ? "after"
            : x < left + 14
              ? "before"
              : x > right - 14
                ? "after"
                : "merge";
      closest = {
        id: element.dataset.promptId,
        placement,
        x: element.offsetLeft + (placement === "before" ? -4 : element.offsetWidth + 3),
        y: element.offsetTop + 3,
        height: element.offsetHeight - 6,
      };
    }
    return closest?.id === pointerDrag.current.id ? null : closest;
  }

  /**
   * 同时用于鼠标和触摸拖放，结束后清除临时高亮。
   * @param {boolean} apply 是否提交当前落点。
   * @returns {void} 更新排序或组合。
   */
  function finishDrop(apply) {
    const active = pointerDrag.current;
    if (!active) return;
    pointerDrag.current = null;
    const { id, pointerId, target, control } = active;
    if (apply && target) {
      capturePositions();
      onChange((current) =>
        dropPrompt(
          current,
          id,
          target.id,
          target.placement,
          crypto.randomUUID(),
        ),
      );
      setChecked([]);
    }
    setDrag(null);
    if (control.hasPointerCapture(pointerId)) control.releasePointerCapture(pointerId);
  }

  /**
   * 点击整个标签主体来选择。多选模式会保留其他已经选中的标签。
   * @param {string} id 点击的提示词 ID。
   * @returns {void} 更新选择状态。
   */
  function pickEntry(id) {
    setChecked((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : multiSelect ? [...current, id] : [id]);
  }

  return (
    <section
      className={`prompt-editor ${collapsed ? "is-collapsed" : ""}`}
      data-editor-density={density}
      aria-label="提示词编辑器"
      onKeyDown={(event) => {
        if (event.key === "Escape" && pointerDrag.current) finishDrop(false);
      }}
    >
      <div className="editor-heading">
        <h2>
          提示词 <span>{count}</span>
        </h2>
        {!collapsed && (
          <div className="editor-toolbar">
            <button
              aria-pressed={multiSelect}
              onClick={() => {
                setMultiSelect(!multiSelect);
                if (multiSelect) setChecked([]);
              }}
            >
              {multiSelect ? "退出多选" : "多选"}
            </button>
            {multiSelect && (
              <>
                <label>
                  <input
                    type="checkbox"
                    aria-label="全选提示词"
                    checked={
                      entries.length > 0 &&
                      selectedIds.length === entries.length
                    }
                    onChange={(event) =>
                      setChecked(
                        event.target.checked
                          ? entries.map((entry) => entry.id)
                          : [],
                      )
                    }
                  />
                  全选
                </label>
                <button
                  disabled={selectedIds.length < 2}
                  onClick={() => {
                    onChange((current) =>
                      mergePrompts(current, selectedIds, crypto.randomUUID()),
                    );
                    setChecked([]);
                  }}
                >
                  合并组
                  {selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
                </button>
              </>
            )}
            <button
              disabled={!entries.length}
              onClick={() => {
                setUndo(entries);
                onChange([]);
                setChecked([]);
              }}
            >
              清空
            </button>
            <button disabled={!entries.length} onClick={() => noteDialog.current.showModal()}>
              <Icon name="star" />收藏为笔记
            </button>
            {undo && !entries.length && (
              <button
                onClick={() => {
                  onChange(undo);
                  setUndo(null);
                }}
              >
                撤销清空
              </button>
            )}
          </div>
        )}
        <select
          aria-label="加权格式"
          value={format}
          onChange={(event) => onFormatChange(event.target.value)}
        >
          <option value="nai">NovelAI</option>
          <option value="sd">Stable Diffusion</option>
        </select>
        <button
          className="icon-button"
          aria-label={collapsed ? "展开提示词" : "收起提示词"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon name={collapsed ? "down" : "up"} />
        </button>
      </div>
      {!collapsed && (
        <div className="editor-body">
          <div className="prompt-sort">
            <div
              className={`prompt-list ${drag ? "is-dragging" : ""}`}
              ref={list}
              onClickCapture={(event) => {
                if (!suppressClick.current || event.detail === 0) return;
                suppressClick.current = false;
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || pointerDrag.current) return;
                suppressClick.current = false;
                const main = event.target.closest(".prompt-entry-main");
                const button = event.target.closest("button");
                if (!main || (button && !button.matches(".prompt-select")) ||
                    event.target.closest("input")) return;
                const entry = main.closest("[data-prompt-id]");
                const control = button || event.target;
                if (!button) main.querySelector(".prompt-select").focus({ preventScroll: true });
                // 捕获保留在按下的标签主体上，轻点仍会触发原按钮的 click。
                control.setPointerCapture(event.pointerId);
                pointerDrag.current = {
                  id: entry.dataset.promptId, pointerId: event.pointerId, control,
                  x: event.clientX, y: event.clientY,
                  target: null, started: false,
                };
              }}
              onPointerMove={(event) => {
                const active = pointerDrag.current;
                if (!active || active.pointerId !== event.pointerId) return;
                const { clientX: x, clientY: y } = event;
                if (!active.started && Math.hypot(x - active.x, y - active.y) < 6) return;
                const bounds = list.current.getBoundingClientRect();
                if (y >= bounds.top && y < bounds.top + 24) list.current.scrollTop -= 12;
                if (y <= bounds.bottom && y > bounds.bottom - 24) list.current.scrollTop += 12;
                const target = locateDrop(x, y);
                if (active.started && target?.id === active.target?.id && target?.placement === active.target?.placement) return;
                const slideMarker = !!active.target && active.target.placement !== "merge";
                if (target && target.placement !== "merge") {
                  markerPosition.current = {
                    transform: `translate(${target.x}px, ${target.y}px)`,
                    height: target.height,
                  };
                }
                suppressClick.current = true;
                active.started = true;
                active.target = target;
                setDrag({ id: active.id, target, slideMarker });
              }}
              onPointerUp={(event) => {
                if (pointerDrag.current?.pointerId === event.pointerId) finishDrop(true);
              }}
              onPointerCancel={(event) => {
                if (pointerDrag.current?.pointerId === event.pointerId) finishDrop(false);
              }}
              onLostPointerCapture={(event) => {
                if (pointerDrag.current?.pointerId === event.pointerId) finishDrop(false);
              }}
            >
              {!entries.length && (
                <div className="editor-empty">
                  <Icon name="plus" />
                  <span>选择标签以添加</span>
                </div>
              )}
              <div aria-hidden="true" style={markerPosition.current || undefined}
                className={`prompt-drop-line ${showMarker ? "is-visible" : ""} ${showMarker && drag.slideMarker ? "is-sliding" : ""}`} />
              {entries.map((entry, position) => {
                const isGroup = entry.type === "group";
                const isExpanded = expanded.includes(entry.id);
                const isSelected = selectedIds.includes(entry.id);
                return (
                  <div
                    key={entry.id}
                    data-prompt-id={entry.id}
                    className={`prompt-entry ${isGroup ? "prompt-group" : "prompt-chip"} ${isSelected ? "is-picked" : ""} ${drag?.id === entry.id ? "is-drag-source" : ""} ${drag?.target?.id === entry.id && drag.target.placement === "merge" ? "drop-merge" : ""}`}
                  >
                    <div className="prompt-entry-main" onClick={(event) => {
                      if (!event.target.closest("button, input")) pickEntry(entry.id);
                    }}>
                      <WeightControl
                        entry={entry}
                        onChange={(weight) =>
                          onChange((current) =>
                            current.map((item) =>
                              item.id === entry.id ? { ...item, weight } : item,
                            ),
                          )
                        }
                      >
                        <button className="prompt-select" aria-label={`选择 ${entry.name}`}
                          aria-pressed={isSelected}
                          title="点击选择，拖动排序或合并。也可用方向键调整顺序。"
                          onClick={() => pickEntry(entry.id)}
                          onKeyDown={(event) => {
                            if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
                            event.preventDefault();
                            const next = position + (event.key === "ArrowLeft" ? -1 : 1);
                            if (next < 0 || next >= entries.length) return;
                            capturePositions();
                            onChange((current) => movePrompt(current, entry.id, next));
                          }}
                        >
                          {isGroup ? (
                            <span className="prompt-entry-label">
                              <span>{entry.name}</span>
                              <span className="prompt-label-secondary">{entry.items.length} 个标签</span>
                            </span>
                          ) : <PromptLabel name={entry.name} cn={entry.cn} mode={labelMode} />}
                        </button>
                      </WeightControl>
                      {isGroup && (
                        <button
                          className="group-toggle icon-button"
                          aria-label={`${isExpanded ? "收起" : "展开"} ${entry.name}`}
                          aria-expanded={isExpanded}
                          onClick={() => setExpanded((current) => isExpanded
                            ? current.filter((id) => id !== entry.id)
                            : [...current, entry.id])}
                        >
                          <Icon name={isExpanded ? "down" : "chevron"} />
                        </button>
                      )}
                      <button
                        className="icon-button remove-prompt"
                        aria-label={`移除 ${entry.name}`}
                        onClick={() =>
                          onChange((current) =>
                            current.filter((item) => item.id !== entry.id),
                          )
                        }
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                    {isGroup && (
                      <>
                        {isExpanded && (
                          <div className="group-edit-heading">
                            <input
                              className="group-name"
                              aria-label="组合名称"
                              value={entry.name}
                              onChange={(event) =>
                                onChange((current) =>
                                  current.map((item) =>
                                    item.id === entry.id
                                      ? { ...item, name: event.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                            <button
                              className="ungroup-button"
                              onClick={() =>
                                onChange((current) =>
                                  ungroupPrompt(current, entry.id),
                                )
                              }
                            >
                              解散组
                            </button>
                          </div>
                        )}
                        <div
                          className={`group-terms ${isExpanded ? "is-expanded" : ""}`}
                        >
                          {entry.items.map((term, index) => (
                            <div className="group-term" key={term.id}>
                              {!isExpanded && <>
                                <PromptLabel name={term.name} cn={term.cn} mode={labelMode} />
                                {term.weight !== 1 && <em>×{term.weight}</em>}
                              </>}
                              {isExpanded && (
                                <>
                                  <WeightControl
                                    entry={term}
                                    label={`${term.name} 组内`}
                                    onChange={(weight) =>
                                      onChange((current) =>
                                        current.map((item) =>
                                          item.id === entry.id
                                            ? {
                                                ...item,
                                                items: item.items.map(
                                                  (child) =>
                                                    child.id === term.id
                                                      ? { ...child, weight }
                                                      : child,
                                                ),
                                              }
                                            : item,
                                        ),
                                      )
                                    }
                                  >
                                    <PromptLabel name={term.name} cn={term.cn} mode={labelMode} />
                                  </WeightControl>
                                  <button
                                    className="icon-button"
                                    aria-label={`前移组内 ${term.name}`}
                                    disabled={index === 0}
                                    onClick={() =>
                                      onChange((current) =>
                                        current.map((item) =>
                                          item.id === entry.id
                                            ? {
                                                ...item,
                                                items: movePrompt(
                                                  item.items,
                                                  term.id,
                                                  index - 1,
                                                ),
                                              }
                                            : item,
                                        ),
                                      )
                                    }
                                  >
                                    <Icon name="up" />
                                  </button>
                                  <button
                                    className="icon-button"
                                    aria-label={`后移组内 ${term.name}`}
                                    disabled={index === entry.items.length - 1}
                                    onClick={() =>
                                      onChange((current) =>
                                        current.map((item) =>
                                          item.id === entry.id
                                            ? {
                                                ...item,
                                                items: movePrompt(
                                                  item.items,
                                                  term.id,
                                                  index + 1,
                                                ),
                                              }
                                            : item,
                                        ),
                                      )
                                    }
                                  >
                                    <Icon name="down" />
                                  </button>
                                  <button
                                    className="icon-button"
                                    aria-label={`移除组内 ${term.name}`}
                                    onClick={() =>
                                      onChange((current) =>
                                        current.flatMap((item) => {
                                          if (item.id !== entry.id)
                                            return [item];
                                          const items = item.items.filter(
                                            (child) => child.id !== term.id,
                                          );
                                          return items.length
                                            ? [{ ...item, items }]
                                            : [];
                                        }),
                                      )
                                    }
                                  >
                                    <Icon name="close" />
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                        {!isExpanded && (
                          <button
                            className="ungroup-button group-dissolve"
                            onClick={() =>
                              onChange((current) =>
                                ungroupPrompt(current, entry.id),
                              )
                            }
                          >
                            解散组
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="prompt-output" data-expanded={outputExpanded}>
            <button
              type="button"
              className="prompt-output-toggle"
              aria-controls="prompt-output"
              aria-expanded={outputExpanded}
              onClick={() => setOutputExpanded((open) => !open)}
            >
              <Icon name={outputExpanded ? "up" : "down"} />
              提示词输出
            </button>
            <textarea
              id="prompt-output"
              aria-label="提示词输出"
              value={output}
              readOnly
              rows={2}
            />
            <button
              className="icon-button copy-prompt"
              aria-label="复制提示词"
              title="复制提示词"
              disabled={!output}
              onClick={() => onCopy(output)}
            >
              <Icon name="copy" />
              <span>复制</span>
            </button>
          </div>
        </div>
      )}
      <dialog ref={noteDialog} className="note-dialog" aria-labelledby="note-title">
        <form className="detail-content" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const input = form.elements.title;
          const title = input.value.trim();
          if (!title) { input.setCustomValidity("请输入笔记名称"); input.reportValidity(); return; }
          if (onSave(title)) {
            form.reset();
            noteDialog.current.close();
          }
        }}>
          <h2 id="note-title">收藏为提示词笔记</h2>
          <label>笔记名称 <input name="title" required maxLength={120}
            onInput={(event) => event.currentTarget.setCustomValidity("")} /></label>
          <div className="backup-actions">
            <button type="submit" className="tool-submit">保存笔记</button>
            <button type="button" className="secondary-button" onClick={() => noteDialog.current.close()}>取消</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
