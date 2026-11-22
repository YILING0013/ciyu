const translateEndpoint =
  "https://index-translate.bilibili.com/v1/chat/completions";

/**
 * 解析 D 站作品编号或链接，只向固定站点请求作品 JSON。
 * @param {string} value 作品编号或 Danbooru 作品链接。
 * @returns {string} 作品 API 地址；无效输入抛出错误。
 */
export function danbooruUrl(value) {
  const input = value.trim();
  if (/^\d+$/.test(input))
    return `https://danbooru.donmai.us/posts/${input}.json`;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("请输入 D 站作品链接或编号");
  }
  const match = url.pathname.match(/^\/posts\/(\d+)(?:\.json)?\/?$/);
  if (
    url.protocol !== "https:" ||
    !["danbooru.donmai.us", "safebooru.donmai.us"].includes(url.hostname) ||
    !match
  )
    throw new Error("请输入 D 站作品链接或编号");
  return `https://danbooru.donmai.us/posts/${match[1]}.json`;
}

/**
 * 调用 Index-Translate 翻译一批标签，按编号校验译文，避免错位写入。
 * @param {string[]} texts 待翻译词条。
 * @param {'en'|'zh'} target 目标语言。
 * @param {AbortSignal} signal 用户取消信号。
 * @returns {Promise<string[]>} 与输入一一对应的译文。
 */
export async function translateTags(texts, target, signal) {
  const source = Object.fromEntries(
    texts.map((text, index) => [String(index), text.replace(/_/g, " ")]),
  );
  const prompt = `请将以下文本翻译成${target === "en" ? "英语" : "中文"}，并且严格遵循所有约束要求。\n\n【源文】\n${JSON.stringify(source)}\n\n【约束要求】\n1. 【注意】这些是独立的图像标签，只翻译词义，不扩写描述。\n2. 【硬性要求】保留 JSON 的所有 key，逐项翻译 value。\n\n请以相同的 JSON 格式输出翻译结果，key 保持不变，value 为对应译文。只输出 JSON，不要有任何额外说明。`;
  const response = await fetch(translateEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    body: JSON.stringify({
      model: "Index-Translate-35B-A3B",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: Math.min(4096, Math.max(256, texts.length * 120)),
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "翻译请求过于频繁，请稍后重试"
        : `Index-Translate 请求失败（${response.status}）`,
    );
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string")
    throw new Error("翻译服务未返回译文，请重试");
  let translated;
  try {
    // 官方示例同样去除思考段；部分模型会为 JSON 加上代码围栏。
    translated = JSON.parse(
      content
        .split("</think>")
        .at(-1)
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    throw new Error("翻译结果格式不正确，请重试");
  }
  if (
    !translated ||
    Array.isArray(translated) ||
    Object.keys(translated).length !== texts.length ||
    texts.some(
      (_, index) =>
        typeof translated[index] !== "string" || !translated[index].trim(),
    )
  )
    throw new Error("翻译结果缺少词条，请重试");
  return texts.map((_, index) => translated[index].trim());
}
