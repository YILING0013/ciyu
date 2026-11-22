/**
 * 显示选择区的双语标签，缺中文时保留可辨识的英文原名。
 * @param {object} props 标签英文名、中文译名及语言顺序。
 * @returns {React.ReactNode} 一行或两行标签文本。
 */
export default function PromptLabel({ name, cn, mode }) {
  const englishFirst = mode === "en" || mode === "en-zh";
  const primary = englishFirst ? name : cn || name;
  const secondary = englishFirst ? cn : cn && name;
  return (
    <span className="prompt-entry-label" title={cn ? `${cn} · ${name}` : name}>
      <span>{primary}</span>
      {secondary && (mode === "zh-en" || mode === "en-zh") && (
        <span className="prompt-label-secondary">{secondary}</span>
      )}
    </span>
  );
}
