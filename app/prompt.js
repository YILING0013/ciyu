/**
 * 将词条与合并组输出为指定模型的数字加权语法。
 * @param {Array} entries 按展示顺序排列的词条和组。
 * @param {'nai'|'sd'} format NovelAI 或 Stable Diffusion。
 * @returns {string} 可复制的完整提示词。
 */
export function serializePrompt(entries, format) {
  const output = [];
  for (const entry of entries) {
    const terms = entry.type === "group" ? entry.items : [entry];
    const weighted = terms.map((term) => ({
      text:
        format === "sd" ? term.name.replace(/[\\()[\]]/g, "\\$&") : term.name,
      weight: Number(
        (term.weight * (entry.type === "group" ? entry.weight : 1)).toFixed(4),
      ),
    }));
    // NovelAI 的 :: 会结束当前权重段，不能按 SD 的方式嵌套；同权重连续词合并成一段。
    const runs = [];
    for (const term of weighted) {
      const previous = runs.at(-1);
      if (previous?.weight === term.weight) previous.text += `, ${term.text}`;
      else runs.push({ ...term });
    }
    for (const { text, weight } of runs) {
      output.push(
        weight === 1
          ? text
          : format === "nai"
            ? `${weight}::${text}::`
            : `(${text}:${weight})`,
      );
    }
  }
  return output.join(", ");
}

/**
 * 将选中的词条或组合合并，保留原顺序与已有的实际权重。
 * @param {Array} entries 当前提示词列表。
 * @param {string[]} ids 选中的顶层项目 ID。
 * @param {string} groupId 新组合 ID。
 * @returns {Array} 在首个选中位置插入组合后的列表。
 */
export function mergePrompts(entries, ids, groupId) {
  const selected = new Set(ids);
  const chosen = entries.filter((entry) => selected.has(entry.id));
  if (chosen.length < 2) return entries;
  const items = chosen.flatMap((entry) =>
    entry.type === "group"
      ? entry.items.map((term) => ({
          ...term,
          weight: Number((term.weight * entry.weight).toFixed(4)),
        }))
      : [entry],
  );
  const group = {
    id: groupId,
    type: "group",
    name: "合并组",
    weight: 1,
    items,
  };
  return entries.flatMap((entry) =>
    entry.id === chosen[0].id ? [group] : selected.has(entry.id) ? [] : [entry],
  );
}

/**
 * 拆开组合，同时将组权重应用到每个词条，保证输出语义不变。
 * @param {Array} entries 当前提示词列表。
 * @param {string} id 待拆分组合的 ID。
 * @returns {Array} 拆分后的顶层词条列表。
 */
export function ungroupPrompt(entries, id) {
  return entries.flatMap((entry) =>
    entry.id === id && entry.type === "group"
      ? entry.items.map((term) => ({
          ...term,
          weight: Number((term.weight * entry.weight).toFixed(4)),
        }))
      : [entry],
  );
}

/**
 * 移动整个词条或组合，供拖动与上下移动按钮共用。
 * @param {Array} entries 当前提示词列表。
 * @param {string} id 移动项目 ID。
 * @param {number} targetIndex 移动后的索引。
 * @returns {Array} 排序后的列表。
 */
export function movePrompt(entries, id, targetIndex) {
  const from = entries.findIndex((entry) => entry.id === id);
  if (from < 0 || targetIndex < 0 || targetIndex >= entries.length)
    return entries;
  const result = [...entries];
  result.splice(targetIndex, 0, ...result.splice(from, 1));
  return result;
}

/**
 * 根据落点插入或合并标签；合并保留目标位置、组名和每个词的实际权重。
 * @param {Array} entries 当前顶层词条。
 * @param {string} sourceId 拖动项目 ID。
 * @param {string} targetId 落点项目 ID。
 * @param {'before'|'after'|'merge'} placement 落点在前、后或标签中央。
 * @param {string} groupId 新组合的 ID。
 * @returns {Array} 操作后的提示词列表。
 */
export function dropPrompt(entries, sourceId, targetId, placement, groupId) {
  if (sourceId === targetId) return entries;
  const source = entries.find((entry) => entry.id === sourceId);
  const target = entries.find((entry) => entry.id === targetId);
  if (!source || !target) return entries;
  const result = entries.filter((entry) => entry.id !== sourceId);
  const position = result.findIndex((entry) => entry.id === targetId);
  if (placement === "merge") {
    const group = mergePrompts(
      [target, source],
      [targetId, sourceId],
      target.type === "group" ? targetId : groupId,
    )[0];
    if (target.type === "group") group.name = target.name;
    result[position] = group;
  } else {
    result.splice(position + (placement === "after" ? 1 : 0), 0, source);
  }
  return result;
}
