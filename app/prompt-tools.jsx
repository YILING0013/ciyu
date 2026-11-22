"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "./ui-icon";
import { danbooruUrl, translateTags } from "./tag-tools";

const tools = { danbooru: "D 站导入", custom: "自定义" };

/**
 * 提供 D 站导入和自定义标签，加载译文后预览并加入提示词。
 * @param {object} props 搜索线程、词库就绪状态及添加回调。
 * @returns {React.ReactNode} 选择模式右侧的工具栏。
 */
export default function PromptTools({ worker, ready, onAdd }) {
  const [active, setActive] = useState("danbooru");
  const [inputs, setInputs] = useState({
    danbooru: "",
    custom: "",
  });
  const [paste, setPaste] = useState(false);
  const [results, setResults] = useState({
    danbooru: [],
    custom: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function run(event) {
    event.preventDefault();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setResults((current) => ({ ...current, [active]: [] }));
    setProgress("读取中");
    try {
      let text = inputs[active].trim();
      if (active === "danbooru" && !paste) {
        const url = danbooruUrl(text);
        let response;
        try {
          response = await fetch(url, {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
          });
        } catch (failure) {
          if (abort.signal.aborted) throw failure;
          throw new Error("D 站访问受限或网络不可用，可改用粘贴标签");
        }
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "作品不存在或已删除"
              : `D 站访问失败（${response.status}），可改用粘贴标签`,
          );
        const post = await response.json();
        if (typeof post.tag_string !== "string" || !post.tag_string.trim())
          throw new Error("作品没有可导入的标签");
        text = post.tag_string;
      }
      const names = [
        ...new Set(
          text
            .split(active === "danbooru" ? /[\s,，]+/ : /[,，\n]+/)
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      ];
      if (!names.length) throw new Error("请输入标签");
      if (names.length > 200) throw new Error("每次最多处理 200 个标签");
      let matches = names.map(() => null);
      if (active !== "custom") {
        setProgress("匹配词库");
        const thread = worker.current;
        const id = crypto.randomUUID();
        matches = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("词库匹配超时，请重试"));
          }, 10000);
          const onAbort = () => {
            cleanup();
            reject(new DOMException("已取消", "AbortError"));
          };
          const onMessage = ({ data }) => {
            if (data.type !== "lookup" || data.id !== id) return;
            cleanup();
            resolve(data.rows);
          };
          const cleanup = () => {
            clearTimeout(timeout);
            thread.removeEventListener("message", onMessage);
            abort.signal.removeEventListener("abort", onAbort);
          };
          thread.addEventListener("message", onMessage);
          abort.signal.addEventListener("abort", onAbort, { once: true });
          thread.postMessage({ type: "lookup", id, texts: names });
        });
      }
      const candidates = names.map((name, index) => {
        const row = matches[index];
        const chinese = /[\u3400-\u9fff]/.test(name);
        return {
          name: row?.[0] || (chinese ? "" : name),
          cn: row?.[2] || (chinese ? name : ""),
          original: name,
          target: chinese ? "en" : "zh",
          source: row?.[2] ? "词库" : "",
          pending: !row?.[2],
        };
      });
      setResults((current) => ({
        ...current,
        [active]: candidates.map((item) => ({ ...item })),
      }));
      // 分批翻译未命中的词，已成功批次保留在预览中，失败不会伪装成已翻译。
      const missing = candidates.filter((item) => item.pending);
      let completed = 0;
      for (const target of ["zh", "en"]) {
        const pending = missing.filter((item) => item.target === target);
        for (let start = 0; start < pending.length; start += 20) {
          setProgress(`翻译 ${completed} / ${missing.length}`);
          const batch = pending.slice(start, start + 20);
          const translated = await translateTags(
            batch.map((item) => item.original),
            target,
            abort.signal,
          );
          batch.forEach((item, index) => {
            if (target === "en") item.name = translated[index];
            else item.cn = translated[index];
            item.pending = false;
            item.source = "Index-Translate";
          });
          completed += batch.length;
          setResults((current) => ({
            ...current,
            [active]: candidates.map((item) => ({ ...item })),
          }));
        }
      }
    } catch (failure) {
      setError(
        abort.signal.aborted
          ? "已取消，已完成的词条可继续添加"
          : failure.name === "TimeoutError"
            ? "翻译超时，请重试"
            : failure.message === "Failed to fetch"
              ? "翻译服务无法连接，请重试"
              : failure.message,
      );
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const items = results[active];
  const available = items.filter((item) => !item.pending);
  return (
    <aside className="prompt-tools" aria-label="标签工具">
      <div className="tools-heading">
        <Icon name="grid" />
        <h2>工具</h2>
      </div>
      <div className="tools-tabs" role="tablist" aria-label="标签工具类型">
        {Object.entries(tools).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={`tool-${key}`}
            aria-controls="tool-panel"
            aria-selected={active === key}
            disabled={busy}
            onClick={() => {
              setActive(key);
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div id="tool-panel" role="tabpanel" aria-labelledby={`tool-${active}`}>
        <form className="tool-form" onSubmit={run}>
          {active === "danbooru" && (
            <div className="import-switch" role="group" aria-label="导入来源">
              <button
                type="button"
                aria-pressed={!paste}
                disabled={busy}
                onClick={() => setPaste(false)}
              >
                作品链接
              </button>
              <button
                type="button"
                aria-pressed={paste}
                disabled={busy}
                onClick={() => setPaste(true)}
              >
                粘贴标签
              </button>
            </div>
          )}
          <textarea
            aria-label={tools[active]}
            placeholder={
              active === "danbooru"
                ? paste
                  ? "粘贴 D 站标签，空格分隔"
                  : "D 站作品链接或编号"
                : "输入标签，逗号或换行分隔"
            }
            value={inputs[active]}
            disabled={busy}
            onChange={(event) =>
              setInputs((current) => ({
                ...current,
                [active]: event.target.value,
              }))
            }
            rows={4}
          />
          <div className="tool-form-actions">
            <button
              className="tool-submit"
              disabled={
                busy ||
                !inputs[active].trim() ||
                (!ready && active !== "custom")
              }
            >
              {busy ? (
                <>
                  <span className="loading-spinner" />
                  {progress}
                </>
              ) : active === "danbooru" ? (
                "导入标签"
              ) : (
                "加载标签"
              )}
            </button>
            {busy ? (
              <button type="button" onClick={() => controller.current.abort()}>
                取消
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setInputs((current) => ({ ...current, [active]: "" }));
                  setResults((current) => ({ ...current, [active]: [] }));
                  setError("");
                }}
              >
                清除
              </button>
            )}
          </div>
        </form>
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        {!!items.length && (
          <div className="tool-results">
            <div className="tool-results-heading">
              <span>{items.length} 个标签</span>
              <button
                disabled={!available.length}
                onClick={() => onAdd(available)}
              >
                添加全部
              </button>
            </div>
            <div className="tool-tags">
              {items.map((item, index) => (
                <button
                  key={`${item.original}:${index}`}
                  disabled={item.pending}
                  title={item.pending ? "待翻译" : item.source}
                  onClick={() => onAdd([item])}
                >
                  <Icon name="plus" />
                  <span>{item.cn || item.original}</span>
                  {item.name && item.name !== item.cn && (
                    <span className="tool-tag-en">{item.name}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
