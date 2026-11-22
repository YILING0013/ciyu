// 默认仅展示普通标签。
export const contentStatuses = ['normal', 'sensitive', 'nsfw'];

/**
 * 判断标注是否符合所选内容状态及全部主题，供查询与联想共用。
 * @param {Array|undefined} annotation 状态与主题数组；缺失的条目不显示。
 * @param {string|string[]} content 一个或多个可展示状态，默认普通。
 * @param {string[]} topics 须同时满足的主题。
 * @returns {boolean} 是否允许在当前筛选结果中展示。
 */
export function matchesContent(annotation, content = 'normal', topics = []) {
  const status = annotation?.[0];
  const enabled = Array.isArray(content) ? content.includes(status) : content === status;
  return enabled && contentStatuses.includes(status) &&
    topics.every(topic => annotation?.[1]?.some(value => value === topic || value.startsWith(`${topic}/`)));
}
