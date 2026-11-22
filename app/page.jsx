"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./ui-icon";
import PromptEditor from "./prompt-editor";
import PromptNotes from "./prompt-notes";
import PromptTools from "./prompt-tools";
import Preferences from "./preferences";
import { defaultWorkspace, openWorkspace, saveWorkspace } from "./workspace-storage";

const displayLevels = {
  normal: "普通",
  sensitive: "敏感",
  nsfw: "NSFW",
};
const formats = new Intl.NumberFormat("en-US");

/**
 * 统一作品名称与搜索词的大小写、全半角及分隔符。
 * @param {string} text 子类别名称、英文标识或搜索词。
 * @returns {string} 用于匹配的文本。
 */
function normalizeFranchiseQuery(text) {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

/**
 * 浏览固定词库；分类、联想和收藏共用搜索线程的内容筛选规则。
 * @returns {React.ReactNode} 标签浏览工作区。
 */
export default function Atlas() {
  const [filters, setFilters] = useState({
    q: "",
    content: ["normal"],
    topics: [],
    section: "browse",
    sort: "popular",
    scope: "all",
  });
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const database = useRef(null);
  const workspaceRef = useRef(defaultWorkspace);
  const restoring = useRef(false);
  const { favorites, entries, notes, format, view, preferences } = workspace;
  const [index, setIndex] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [expanded, setExpanded] = useState({});
  const [franchiseQuery, setFranchiseQuery] = useState("");
  const [mobile, setMobile] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [toast, setToast] = useState("");
  const [mode, setMode] = useState("browse");
  const [panel, setPanel] = useState(null);
  const [favoritesView, setFavoritesView] = useState("tags");
  const [noteQuery, setNoteQuery] = useState("");
  const isFavorites = filters.section === "favorites";
  const showingNotes = isFavorites && favoritesView === "notes" && !panel;
  const [loadingMore, setLoadingMore] = useState(false);
  const worker = useRef(null);
  const requestId = useRef(0);
  const requestKey = useRef("");
  const search = useRef(null);
  const franchiseSearch = useRef(null);
  const sidebar = useRef(null);
  const menuButton = useRef(null);
  const dialog = useRef(null);
  const sentinel = useRef(null);
  const tagViewport = useRef(null);
  const pagePending = useRef(false);
  const settingsButton = useRef(null);
  const selectedTopic = filters.topics[0];
  // 浏览时收藏图标的变化不影响查询，避免收藏一次就重置已滚动加载的结果。
  const key = JSON.stringify([
    filters,
    filters.section === "favorites" &&
    !(filters.q.trim() && filters.scope === "all")
      ? favorites
      : [],
  ]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedContent = params.get("content");
    const topics = params.getAll("topic").filter((topic) => topic !== "pending").slice(0, 1);
    const enabled = Object.keys(displayLevels).filter((level) => requestedContent?.split(",").includes(level));
    const section = params.get("section") === "favorites" ? "favorites" : "browse";
    setFilters({
      q: params.get("q") || "",
      content: requestedContent === "none" || enabled.length ? enabled : ["normal"],
      topics,
      section,
      sort: ["popular", "relevance", "name", "least"].includes(
        params.get("sort"),
      )
        ? params.get("sort")
        : "popular",
      scope: params.get("scope") === "current" ||
        (!params.has("q") && (topics.length || section === "favorites")) ? "current" : "all",
    });
    setExpanded(
      Object.fromEntries(topics.map((topic) => [topic.split("/")[0], true])),
    );
    const media = window.matchMedia("(max-width: 800px)");
    const resize = () => {
      setMobile(media.matches);
      if (!media.matches) setMenuOpen(false);
    };
    resize();
    media.addEventListener("change", resize);
    const shortcut = (event) => {
      if (
        (event.key === "k" && (event.ctrlKey || event.metaKey)) ||
        (event.key === "/" &&
          !["INPUT", "TEXTAREA", "SELECT"].includes(
            document.activeElement.tagName,
          ))
      ) {
        if (document.querySelector("dialog[open]") || !search.current) return;
        event.preventDefault();
        search.current.focus();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => {
      media.removeEventListener("change", resize);
      window.removeEventListener("keydown", shortcut);
    };
  }, []);

  useEffect(() => {
    let active = true;
    openWorkspace().then(({ database: connection, data }) => {
      if (!active) { connection.close(); return; }
      database.current = connection;
      workspaceRef.current = data;
      setWorkspace(data);
      setWorkspaceReady(true);
    }).catch(() => {
      if (!active) return;
      setStorageError("无法打开 IndexedDB，请检查浏览器站点存储设置后刷新。");
      setToast("无法读取个人数据");
    });
    return () => {
      active = false;
      database.current?.close();
      database.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let appliedVersion = "";
    let pendingVersion = "";
    let checking = false;
    let lastFailure = "";
    const controller = new AbortController();
    setError("");
    setIndex(null);
    setProgress(0);
    setResult(null);
    setSuggestions(null);
    const thread = new Worker("/search-worker.js", { type: "module" });
    worker.current = thread;
    thread.onmessage = ({ data }) => {
      if (!active) return;
      if (data.type === "progress")
        setProgress(Math.round((data.loaded / data.total) * 100));
      if (data.type === "ready") {
        const updated = !!appliedVersion;
        appliedVersion = pendingVersion;
        pendingVersion = "";
        lastFailure = "";
        setError("");
        // 使旧分页和详情立即失效，防止内容状态更新后继续显示上一版词条。
        requestId.current++;
        pagePending.current = false;
        setLoadingMore(false);
        setResult(null);
        setSuggestions(null);
        setDetail(null);
        setIndex(data);
        if (updated) setToast("词库已更新");
        // 内容开关可能让当前类别暂时为空。仅清除词库中已经不存在的类别。
        setFilters((current) => {
          const topic = current.topics[0];
          if (!topic || topic === "pending") return current;
          const [parent, child] = topic.split("/");
          const group = Object.hasOwn(data.taxonomy, parent) && data.taxonomy[parent];
          return group && (!child || Object.hasOwn(group.children, child))
            ? current
            : { ...current, topics: [] };
        });
      }
      if (data.type === "error") {
        pendingVersion = "";
        setError(data.message);
        setIndex(null);
      }
      if (data.type === "update-error") {
        pendingVersion = "";
        if (lastFailure !== data.message)
          setToast("词库更新失败，继续使用上一版，稍后自动重试");
        lastFailure = data.message;
      }
      if (data.id !== requestId.current) return;
      if (data.type === "results") {
        const responseKey = requestKey.current;
        setResult((previous) =>
          data.page === 1
            ? { ...data, key: responseKey }
            : previous?.key === responseKey && data.page === previous.page + 1
              ? {
                  ...data,
                  key: responseKey,
                  rows: [...previous.rows, ...data.rows],
                }
              : previous,
        );
        pagePending.current = false;
        setLoadingMore(false);
      }
      if (data.type === "suggestions")
        setSuggestions({ ...data, key: requestKey.current });
    };
    thread.onerror = () => {
      if (active) {
        setError("搜索线程加载失败");
        setIndex(null);
      }
    };
    /**
     * 检查清单并让搜索线程验证新版本，避免重叠下载。
     * @returns {Promise<void>} 无参数；成功切换由线程 ready 消息确认。
     */
    async function checkUpdate() {
      if (!active || checking || pendingVersion || document.hidden) return;
      checking = true;
      try {
        const response = await fetch("/data/manifest.json", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error("词库加载失败");
        const manifest = await response.json();
        // 固定源提交不随分类或纠错更新而改变，因此比较两份快照指纹。
        const version = JSON.stringify([
          manifest.commit, manifest.total, manifest.chunks,
          manifest.classification, manifest.translations,
        ]);
        if (active && version !== appliedVersion) {
          pendingVersion = version;
          thread.postMessage({ type: "init", manifest });
        }
      } catch (failure) {
        if (!active) return;
        if (!appliedVersion) setError(failure.message);
        else if (lastFailure !== failure.message)
          setToast("暂时无法检查词库更新，稍后自动重试");
        lastFailure = failure.message;
      } finally {
        checking = false;
      }
    }
    checkUpdate();
    const timer = setInterval(checkUpdate, 60000);
    document.addEventListener("visibilitychange", checkUpdate);
    window.addEventListener("online", checkUpdate);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", checkUpdate);
      window.removeEventListener("online", checkUpdate);
      thread.terminate();
    };
  }, [attempt]);

  useEffect(() => {
    if (!index) return;
    const id = ++requestId.current;
    requestKey.current = key;
    pagePending.current = true;
    setLoadingMore(false);
    setSuggestIndex(-1);
    const timer = setTimeout(() => {
      const query = {
        ...filters,
        content: filters.content,
        topics: filters.topics,
        category: "all",
        favorites,
        id,
        page: 1,
        size: 60,
      };
      worker.current.postMessage({ type: "query", ...query });
      worker.current.postMessage({ type: "suggest", ...query });
      const params = new URLSearchParams();
      if (filters.q) params.set("q", filters.q);
      const content = filters.content.join(",") || "none";
      if (content !== "normal") params.set("content", content);
      filters.topics.forEach((topic) => params.append("topic", topic));
      if (filters.section !== "browse") params.set("section", filters.section);
      if (filters.sort !== "popular") params.set("sort", filters.sort);
      if (filters.q && filters.scope === "current")
        params.set("scope", "current");
      window.history.replaceState(
        null,
        "",
        `/${params.size ? `?${params}` : ""}`,
      );
    }, 120);
    return () => clearTimeout(timer);
  }, [key, index]);

  useEffect(() => {
    if (detail?.key === key) dialog.current.showModal();
    else dialog.current.close();
  }, [detail, key]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!menuOpen) return;
    sidebar.current.querySelector("button").focus();
    const keyboard = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) setMenuOpen(false);
      if (event.key !== "Tab") return;
      const controls = [
        ...sidebar.current.querySelectorAll("button, input, select"),
      ].filter((element) => element.getClientRects().length);
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", keyboard);
      document.body.style.overflow = "";
      menuButton.current?.focus();
    };
  }, [menuOpen]);

  // 在筛选变更的同一次渲染中隐藏旧结果，避免异步响应带出已关闭的内容状态。
  const current = index && result?.key === key ? result : null;
  const suggested = index && suggestions?.key === key ? suggestions.rows : [];
  const visibleSuggestions = preferences.suggestions && suggestOpen && filters.q && suggested.length > 0;
  const facet = useMemo(() => {
    if (!index) return null;
    const combined = { total: 0, topics: {} };
    for (const level of filters.content) {
      const status = index.facets[level];
      combined.total += status.total;
      for (const [topic, count] of Object.entries(status.topics)) {
        combined.topics[topic] = (combined.topics[topic] || 0) + count;
      }
    }
    return combined;
  }, [index, filters.content]);
  const taxonomy = index?.taxonomy;
  const franchiseChildren = useMemo(() => {
    const children = Object.entries(taxonomy?.franchise?.children || {});
    if (!index?.franchiseReferences) return children;
    const levels = filters.content.map((level) => index.franchiseReferences[level]);
    return children.map((entry) => {
      const topic = `franchise/${entry[0]}`;
      const size = facet.topics[topic] || 0;
      const tier = size >= 30 ? 2 : size >= 3 ? 1 : 0;
      // 数量决定档位。合并已开启的级别后，再取引用量最高的三个标签计算均值。
      const top = levels.flatMap((level) => level[topic] || []).sort((a, b) => b - a).slice(0, 3);
      const average = top.length ? top.reduce((sum, count) => sum + count, 0) / top.length : 0;
      return { entry, tier, average };
    }).sort((a, b) => b.tier - a.tier || b.average - a.average).map(({ entry }) => entry);
  }, [index, taxonomy, facet, filters.content]);
  const franchiseKeyword = normalizeFranchiseQuery(franchiseQuery);
  const labels = useMemo(() => Object.fromEntries(
    Object.entries(taxonomy || {}).flatMap(([parent, group]) => [
      [parent, group.label],
      ...Object.entries(group.children).map(([child, label]) => [
        `${parent}/${child}`,
        label,
      ]),
    ]),
  ), [taxonomy]);
  const globalSearch = !!filters.q.trim() && filters.scope === "all";
  const title = globalSearch
    ? "全库搜索"
    : labels[selectedTopic] || "全部标签";
  const selectedCounts = useMemo(() => {
    const counts = new Map();
    for (const entry of entries) {
      for (const tag of entry.type === "group" ? entry.items : [entry]) {
        counts.set(tag.name, (counts.get(tag.name) || 0) + 1);
      }
    }
    return counts;
  }, [entries]);
  const selectionCount = entries.reduce((total, entry) =>
    total + (entry.type === "group" ? entry.items.length : 1), 0);
  const detailRow = detail?.key === key ? detail.row : null;

  useEffect(() => {
    if (preferences.accordion) {
      setExpanded((current) => {
        const open = Object.keys(current).filter((parent) => current[parent]);
        return open.length > 1 ? { [open.at(-1)]: true } : current;
      });
    }
  }, [preferences.accordion]);

  useEffect(() => {
    if (!sentinel.current || !current || current.rows.length >= current.total) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || pagePending.current) return;
        pagePending.current = true;
        setLoadingMore(true);
        worker.current.postMessage({
          type: "query",
          ...filters,
          content: filters.content,
          topics: filters.topics,
          category: "all",
          favorites,
          id: requestId.current,
          page: current.page + 1,
          size: 60,
        });
      },
      {
        root: mode === "select" ? tagViewport.current : null,
        rootMargin: "0px 0px 500px 0px",
      },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [current?.page, current?.total, key, index, view, mode, panel, showingNotes]);

  /**
   * 先呈现编辑结果，再保存本次修改的字段，避免其它标签页的无关数据被覆盖。
   * @param {object} patch 工作区中改变的字段。
   * @returns {boolean} 是否接受修改。
   */
  function changeWorkspace(patch) {
    if (!database.current || restoring.current) {
      setToast("个人数据暂不可编辑");
      return false;
    }
    workspaceRef.current = { ...workspaceRef.current, ...patch };
    setWorkspace(workspaceRef.current);
    saveWorkspace(database.current, patch).catch(() => {
      setStorageError("个人数据写入失败，可以先导出当前页面中的数据。");
      setToast("个人数据写入失败");
    });
    return true;
  }

  /**
   * 更新编辑区提示词，和 React 状态更新一样支持直接列表或基于旧列表计算。
   * @param {Array|Function} update 新列表或更新函数。
   * @returns {boolean} 是否接受修改。
   */
  function setEntries(update) {
    const current = workspaceRef.current.entries;
    const next = typeof update === "function" ? update(current) : update;
    return next === current || changeWorkspace({ entries: next });
  }

  /**
   * 追加词条，每次添加产生独立实例，允许重复英文名和不同权重。
   * @param {Array} tags 词库或导入工具提供的名称和翻译。
   * @returns {boolean} 是否接受修改。
   */
  function addTags(tags) {
    return setEntries((current) => [...current, ...tags.map((tag) => ({
      id: crypto.randomUUID(),
      type: "tag",
      name: tag.name,
      cn: tag.cn || "",
      weight: 1,
    }))]);
  }

  /**
   * 切换浏览条件，同时重置页码和临时浮层。
   * @param {object} patch 本次改变的筛选字段。
   * @param {boolean} keepMenu 是否保留移动端侧栏。
   * @returns {void} 更新界面状态。
   */
  function changeFilters(patch, keepMenu = false) {
    if ("topics" in patch || "section" in patch) setFavoritesView("tags");
    setFilters((current) => ({
      ...current,
      ...patch,
      scope:
        patch.scope || (("topics" in patch || "section" in patch) ? "current" : current.scope),
    }));
    setDetail(null);
    setSuggestOpen(false);
    if (!keepMenu) setMenuOpen(false);
  }

  /**
   * 保存或取消标签收藏。
   * @param {string} name 标签的原始英文名。
   * @returns {void} 更新收藏并报告真实存储错误。
   */
  function toggleFavorite(name) {
    const saved = workspaceRef.current.favorites;
    changeWorkspace({ favorites: saved.includes(name)
      ? saved.filter((value) => value !== name)
      : [...saved, name] });
  }

  /**
   * 复制原始英文标签，供列表和详情共用。
   * @param {string} name 待复制的英文名。
   * @returns {Promise<void>} 复制完成后显示结果。
   */
  async function copy(name) {
    try {
      await navigator.clipboard.writeText(name);
      setToast("已复制");
    } catch {
      setToast("复制失败，请手动选择词条");
    }
  }

  return (
    <div className={`atlas ${mode === "select" && !panel ? "is-select" : ""}`}
      data-scheme={preferences.scheme} data-accent={preferences.accent} data-density={preferences.density}>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      {menuOpen && (
        <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />
      )}
      <aside
        ref={sidebar}
        className={`sidebar ${menuOpen ? "is-open" : ""}`}
        aria-label="分类侧栏"
        inert={mobile && !menuOpen}
      >
        <div className="brand">
          <span className="brand-mark">
            <Icon name="hash" />
          </span>
          <span>词屿</span>
          <button
            className="icon-button mobile-only"
            aria-label="关闭分类"
            onClick={() => setMenuOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <nav className="library-nav" aria-label="词库">
          <button
            data-section="browse"
            className={filters.section === "browse" ? "active" : ""}
            onClick={() => {
              setPanel(null);
              changeFilters({ section: "browse", topics: [], scope: "all" });
            }}
          >
            <Icon name="grid" />
            标签词库
          </button>
          <button
            data-section="favorites"
            className={filters.section === "favorites" ? "active" : ""}
            onClick={() => {
              setPanel(null);
              changeFilters({ section: "favorites" });
            }}
          >
            <Icon name="star" />
            我的收藏
          </button>
          <button aria-current={panel === "about" ? "page" : undefined}
            className={panel === "about" ? "active" : ""}
            onClick={() => {
              setPanel("about");
              setDetail(null);
              setMenuOpen(false);
            }}>
            <Icon name="info" />
            关于
          </button>
        </nav>
        <div className="content-filter">
          <span id="content-filter-label">内容级别</span>
          <div className="content-switches" role="group" aria-labelledby="content-filter-label">
            {Object.entries(displayLevels).map(([level, label]) => (
              <button key={level} data-level={level} aria-pressed={filters.content.includes(level)}
                onClick={() => {
                  const enabled = filters.content.includes(level)
                    ? filters.content.filter((value) => value !== level)
                    : Object.keys(displayLevels).filter((value) => value === level || filters.content.includes(value));
                  changeFilters({ content: enabled }, true);
                }}
              >
                <span className="switch-check"><Icon name="check" /></span>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="tree-heading">
          <span>分类目录</span>
          {selectedTopic && (
            <button onClick={() => changeFilters({ topics: [] })}>清除</button>
          )}
        </div>
        <nav className="category-tree" aria-label="标签分类">
          <button
            className={`tree-all ${!selectedTopic ? "selected" : ""}`}
            aria-pressed={!selectedTopic}
            onClick={() => {
              setPanel(null);
              changeFilters({ topics: [] });
            }}
          >
            <Icon name="hash" />
            <span>全部标签</span>
            <span className="tree-count">
              {facet ? formats.format(facet.total) : "—"}
            </span>
          </button>
          {Object.entries(taxonomy || {})
            .filter(([parent]) => facet.topics[parent] > 0 || selectedTopic?.split("/")[0] === parent)
            .map(([parent, group]) => {
              const isFranchise = parent === "franchise";
              const orderedChildren = isFranchise ? franchiseChildren : Object.entries(group.children);
              const children = orderedChildren.filter(([child]) => {
                const topic = `${parent}/${child}`;
                return facet.topics[topic] > 0 || selectedTopic === topic;
              });
              const isExpanded = children.length > 0 && !!expanded[parent];
              const isSelected = selectedTopic?.split("/")[0] === parent;
              const matchingChildren = isExpanded && isFranchise && franchiseKeyword
                ? children.filter(([child, label]) => [child, label].some((text) => normalizeFranchiseQuery(text).includes(franchiseKeyword)))
                : children;
              return (
                <div className="tree-group" key={parent}>
                  <button
                    className={`tree-parent parent-label ${isSelected ? "selected" : ""}`}
                    data-topic={parent}
                    aria-current={selectedTopic === parent ? "true" : undefined}
                    aria-expanded={children.length ? isExpanded : undefined}
                    aria-controls={isExpanded ? `children-${parent}` : undefined}
                    onClick={() => {
                      setPanel(null);
                      if (isExpanded) {
                        setExpanded((current) => {
                          const next = { ...current };
                          delete next[parent];
                          return next;
                        });
                        if (!isSelected) changeFilters({ topics: [parent] }, true);
                        return;
                      }
                      if (children.length) {
                        setExpanded((current) => preferences.accordion
                          ? { [parent]: true }
                          : { ...current, [parent]: true });
                      }
                      changeFilters({ topics: [parent] }, !!children.length);
                    }}
                  >
                    <Icon name={parent} />
                    <span>{group.label}</span>
                    <span className="tree-count">{formats.format(facet.topics[parent] || 0)}</span>
                    {children.length > 0 && <Icon name="chevron" className="tree-chevron" />}
                  </button>
                  {isExpanded && (
                    <div className="tree-children" id={`children-${parent}`}>
                      {isFranchise && (
                        <div className="franchise-search">
                          <Icon name="search" />
                          <input
                            ref={franchiseSearch}
                            type="search"
                            aria-label="搜索作品 / IP 子类别"
                            placeholder="搜索子类别（中英文）"
                            value={franchiseQuery}
                            onChange={(event) => setFranchiseQuery(event.target.value)}
                            onKeyDownCapture={(event) => {
                              if (event.key === "Escape" && franchiseQuery) {
                                event.preventDefault();
                                event.stopPropagation();
                                setFranchiseQuery("");
                              }
                            }}
                          />
                          {franchiseQuery && (
                            <button className="franchise-search-clear" type="button" aria-label="清空子类别搜索" onClick={() => {
                              setFranchiseQuery("");
                              franchiseSearch.current?.focus();
                            }}>
                              <Icon name="close" />
                            </button>
                          )}
                        </div>
                      )}
                      {matchingChildren.length === 0 && <p className="franchise-search-empty" role="status">没有匹配的子类别</p>}
                      {matchingChildren.map(([child, label]) => {
                        const topic = `${parent}/${child}`;
                        return (
                          <button
                            key={child}
                            data-topic={topic}
                            className={selectedTopic === topic ? "selected" : ""}
                            aria-pressed={selectedTopic === topic}
                            onClick={() => {
                              setPanel(null);
                              changeFilters({ topics: [topic] });
                            }}
                          >
                            <span>{label}</span>
                            <span className="tree-count">{formats.format(facet.topics[topic] || 0)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
        </nav>
      </aside>

      <div className="workspace" inert={menuOpen}>
        <div className="workspace-header">
        <header className="topbar">
          <button
            id="menu-button"
            ref={menuButton}
            className="icon-button mobile-only"
            aria-label="打开分类"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Icon name="menu" />
          </button>
          {showingNotes ? (
            <div className="search-area">
              <div className="search-box">
                <Icon name="search" />
                <input ref={search} type="search" aria-label="搜索提示词笔记" placeholder="搜索笔记标题或标签…"
                  value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} />
                {noteQuery && <button className="icon-button" aria-label="清除笔记搜索" onClick={() => setNoteQuery("")}>
                  <Icon name="close" />
                </button>}
              </div>
            </div>
          ) : !panel && <div className="search-area">
            <div
              className={`search-box ${visibleSuggestions ? "suggesting" : ""}`}
            >
              <Icon name="search" />
              <select
                className="search-scope"
                aria-label="搜索范围"
                value={filters.scope}
                onChange={(event) =>
                  changeFilters({ scope: event.target.value })
                }
              >
                <option value="all">全部分类</option>
                <option value="current">当前分类</option>
              </select>
              <input
                id="search-input"
                ref={search}
                type="search"
                autoComplete="off"
                placeholder="搜索中英文标签…"
                aria-label="搜索中英文标签"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={!!visibleSuggestions}
                aria-controls="search-suggestions"
                aria-activedescendant={
                  visibleSuggestions && suggestIndex >= 0
                    ? `suggestion-${suggestIndex}`
                    : undefined
                }
                value={filters.q}
                onFocus={() => setSuggestOpen(true)}
                onBlur={() => setSuggestOpen(false)}
                onChange={(event) => {
                  setFilters((current) => ({
                    ...current,
                    q: event.target.value,
                  }));
                  setSuggestOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSuggestOpen(false);
                    return;
                  }
                  if (
                    ["ArrowDown", "ArrowUp"].includes(event.key) &&
                    preferences.suggestions && suggested.length
                  ) {
                    event.preventDefault();
                    setSuggestOpen(true);
                    setSuggestIndex((current) =>
                      current < 0
                        ? event.key === "ArrowDown"
                          ? 0
                          : suggested.length - 1
                        : (current +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            suggested.length) %
                          suggested.length,
                    );
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (visibleSuggestions && suggestIndex >= 0)
                      changeFilters({ q: suggested[suggestIndex][0] });
                    setSuggestOpen(false);
                  }
                }}
              />
              {filters.q ? (
                <button
                  id="clear-search"
                  className="icon-button"
                  aria-label="清除搜索"
                  onClick={() => changeFilters({ q: "" })}
                >
                  <Icon name="close" />
                </button>
              ) : (
                <kbd>Ctrl K</kbd>
              )}
            </div>
            <div
              id="search-suggestions"
              role="listbox"
              aria-label="搜索联想"
              hidden={!visibleSuggestions}
            >
              {visibleSuggestions &&
                suggested.map((row, i) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === suggestIndex}
                    id={`suggestion-${i}`}
                    className="suggestion"
                    key={row[0]}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => changeFilters({ q: row[0] })}
                  >
                    <Icon name="hash" />
                    <span className="suggest-name">{row[0]}</span>
                    <span className="suggest-cn">{row[2]}</span>
                  </button>
                ))}
            </div>
          </div>}
          {!panel && <div className="mode-switch" role="group" aria-label="工作模式">
            <button
              aria-pressed={mode === "browse"}
              onClick={() => setMode("browse")}
            >
              浏览
            </button>
            <button
              aria-pressed={mode === "select"}
              onClick={() => setMode("select")}
            >
              选择{selectionCount > 0 ? ` · ${selectionCount}` : ""}
            </button>
          </div>}
          <button className="settings-trigger" ref={settingsButton} aria-pressed={panel === "settings"}
            onClick={() => { setDetail(null); setPanel((current) => current === "settings" ? null : "settings"); }}>
            <Icon name="settings" /><span>设置</span>
          </button>
        </header>
        {!panel && isFavorites && (
          <div className="favorites-bar">
            <div className="favorites-heading">
              <h1>我的收藏</h1>
              <div className="settings-options" role="group" aria-label="收藏类型">
                <button aria-pressed={!showingNotes} onClick={() => setFavoritesView("tags")}>标签收藏</button>
                <button aria-pressed={showingNotes} onClick={() => {
                  setSuggestOpen(false);
                  setFavoritesView("notes");
                }}>提示词笔记</button>
              </div>
            </div>
          </div>
        )}
        </div>

        {panel === "settings" ? (
          <Preferences workspace={workspace} ready={workspaceReady} storageError={storageError}
            onChange={changeWorkspace}
            onRestore={async (data) => {
              restoring.current = true;
              try {
                const restored = await saveWorkspace(database.current, data);
                workspaceRef.current = restored;
                setWorkspace(restored);
                setStorageError("");
                setToast("备份已恢复");
              } catch {
                throw new Error("恢复失败，浏览器未能保存备份");
              } finally {
                restoring.current = false;
              }
            }}
            onClose={() => { setPanel(null); settingsButton.current.focus(); }} />
        ) : panel === "about" ? (
          <main className="settings-page" id="main">
            <div className="settings-heading">
              <div><h1>关于词屿</h1><p>Danbooru 中英文标签词库与提示词编辑器。</p></div>
              <button className="secondary-button" onClick={() => setPanel(null)}>返回词库</button>
            </div>
            <section className="settings-card about-links" aria-label="项目链接">
              <a href="https://github.com/YILING0013/ciyu" target="_blank" rel="noreferrer">GitHub 源码仓库</a>
              <a href="https://yihan.art/" target="_blank" rel="noreferrer">绘画网站 · yihan.art</a>
            </section>
          </main>
        ) : showingNotes ? (
          <main id="main" className="notes-main">
          <PromptNotes notes={notes} query={noteQuery}
            onRemove={(id) => changeWorkspace({ notes: workspaceRef.current.notes.filter((note) => note.id !== id) })}
            onImport={(note) => {
              // 每次导入使用新的 ID，重复导入不会影响原笔记、已有组或同名标签。
              const imported = note.entries.map((entry) => ({
                ...entry, id: crypto.randomUUID(),
                ...(entry.type === "group" && {
                  items: entry.items.map((item) => ({ ...item, id: crypto.randomUUID() })),
                }),
              }));
              const current = workspaceRef.current;
              if (changeWorkspace({
                entries: [...current.entries, ...imported],
                format: current.entries.length ? current.format : note.format,
              })) {
                setMode("select");
                changeFilters({ section: "browse", q: "", topics: [], scope: "all" });
                setToast("笔记已导入选择区");
              }
            }} />
          </main>
        ) : <div
          className={`content-layout ${mode === "select" ? "with-editor" : ""}`}
        >
          <main id="main">
            {mode === "select" && (
              <PromptEditor
                entries={entries}
                onChange={setEntries}
                format={format}
                onFormatChange={(next) => changeWorkspace({ format: next })}
                onCopy={copy}
                density={preferences.editorDensity}
                labelMode={preferences.editorLabel}
                onSave={(title) => {
                  const current = workspaceRef.current;
                  const note = {
                    id: crypto.randomUUID(), title, format: current.format,
                    entries: current.entries,
                  };
                  if (!changeWorkspace({ notes: [note, ...current.notes] })) return false;
                  setToast("已收藏提示词笔记");
                  return true;
                }}
              />
            )}
            <div className="results-toolbar">
              <div className="results-title">
                {!isFavorites ? <h1>{title}</h1> : globalSearch && <h2 className="favorite-result-title">{title}</h2>}
                <span id="result-count">
                  {current ? formats.format(current.total) : "—"}
                </span>
              </div>
              <div className="results-actions">
                <div className="view-switch" role="group" aria-label="展示形式">
                  <button
                    aria-label="胶囊视图"
                    aria-pressed={view === "pills"}
                    onClick={() => changeWorkspace({ view: "pills" })}
                  >
                    <Icon name="pill" />
                  </button>
                  <button
                    aria-label="表格视图"
                    aria-pressed={view === "table"}
                    onClick={() => changeWorkspace({ view: "table" })}
                  >
                    <Icon name="table" />
                  </button>
                </div>
                <select
                  id="sort-select"
                  aria-label="排序方式"
                  value={filters.sort}
                  onChange={(event) =>
                    changeFilters({ sort: event.target.value })
                  }
                >
                  <option value="popular">引用最多</option>
                  <option value="relevance">匹配优先</option>
                  <option value="name">名称 A–Z</option>
                  <option value="least">引用最少</option>
                </select>
              </div>
            </div>
            <div className="tag-browser" ref={tagViewport}>
              {filters.q && (
                <div className="query-label">“{filters.q}” 的搜索结果</div>
              )}
              {!index && (
                <div
                  id="index-status"
                  className={`index-status ${error ? "error" : ""}`}
                  role={error ? "alert" : "status"}
                >
                  {error ? (
                    <>
                      <span>{error}</span>
                      <button onClick={() => setAttempt((value) => value + 1)}>
                        重试
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="loading-spinner" />
                      正在加载词库 {progress}%
                    </>
                  )}
                </div>
              )}
              <div
                key={view}
                className={view === "table" ? "tag-table" : "tag-waterfall"}
                id="tag-results"
                aria-busy={!current && !error}
              >
                {view === "table" && (
                  <div className="table-heading">
                    <span>英文标签</span>
                    <span>中文</span>
                    <span>分类</span>
                    <span>引用</span>
                    {mode === "browse" && <span className="actions-heading">操作</span>}
                  </div>
                )}
                {current?.rows.map((row) => (
                  <article
                    key={row[0]}
                    className={`${view === "table" ? "tag-row" : "tag-pill"} ${mode === "select" && selectedCounts.has(row[0]) ? "is-selected" : ""}`}
                  >
                    <button
                      className="tag-identity"
                      aria-label={
                        mode === "select" ? `添加 ${row[0]}` : `查看 ${row[0]}`
                      }
                      onClick={() =>
                        mode === "select"
                          ? addTags([{ name: row[0], cn: row[2] }])
                          : setDetail({ row, key })
                      }
                    >
                      {mode === "select" && view === "table" && (
                        <span className="select-indicator">
                          <Icon name="plus" />
                        </span>
                      )}
                      <span className="tag-name" title={row[0]}>
                        {row[0]}
                      </span>
                      <span className="tag-cn" title={row[2] || ""}>
                        {row[2] || "—"}
                      </span>
                      {mode === "select" && view === "pills" && selectedCounts.has(row[0]) && (
                        <span className="selection-count" aria-hidden="true">
                          {selectedCounts.get(row[0]) > 99 ? "99+" : `×${selectedCounts.get(row[0])}`}
                        </span>
                      )}
                    </button>
                    {view === "table" && (
                      <>
                        <span
                          className="tag-topic"
                          title={row[5]
                            .map((topic) => labels[topic])
                            .join("、")}
                        >
                          {row[5].length ? labels[row[5][0]] : "—"}
                        </span>
                        <span className="post-count">
                          {formats.format(row[3])}
                        </span>
                      </>
                    )}
                    {mode === "browse" && <div className="row-actions">
                      <button
                        className={`icon-button favorite-button ${favorites.includes(row[0]) ? "saved" : ""}`}
                        aria-label={`${favorites.includes(row[0]) ? "取消收藏" : "收藏"} ${row[0]}`}
                        aria-pressed={favorites.includes(row[0])}
                        onClick={() => toggleFavorite(row[0])}
                      >
                        <Icon name="star" />
                      </button>
                      <button
                        className="icon-button copy-button"
                        aria-label={`复制 ${row[0]}`}
                        onClick={() => copy(row[0])}
                      >
                        <Icon name="copy" />
                      </button>
                    </div>}
                  </article>
                ))}
              </div>
              {index && !current && (
                <div className="empty-state" role="status">
                  <span className="loading-spinner" />
                  搜索中
                </div>
              )}
              {current && !current.rows.length && (
                <div className="empty-state">
                  <Icon
                    name={filters.section === "favorites" ? "star" : "search"}
                  />
                  <span>{filters.content.length ? "没有匹配的标签" : "所有内容级别都已关闭"}</span>
                  {!filters.content.length ? (
                    <button onClick={() => changeFilters({ content: ["normal"] })}>开启普通标签</button>
                  ) : (filters.q || selectedTopic) && (
                    <button
                      onClick={() => changeFilters({ q: "", topics: [] })}
                    >
                      清除筛选
                    </button>
                  )}
                </div>
              )}
              <div ref={sentinel} className="load-sentinel" role="status">
                {current &&
                  (loadingMore ? (
                    <>
                      <span className="loading-spinner" />
                      加载中
                    </>
                  ) : (
                    <span>
                      {formats.format(current.rows.length)} /{" "}
                      {formats.format(current.total)}
                      {current.rows.length >= current.total
                        ? " · 已全部加载"
                        : ""}
                    </span>
                  ))}
              </div>
            </div>
          </main>
          {mode === "select" && (
            <PromptTools
              worker={worker}
              ready={!!index}
              onAdd={addTags}
            />
          )}
        </div>}
      </div>

      <dialog
        ref={dialog}
        id="detail-dialog"
        onClose={() => setDetail(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current.close();
        }}
        aria-labelledby="detail-title"
      >
        {detailRow && (
          <div className="detail-content">
            <div className="detail-heading">
              <Icon name="hash" />
              <button
                className="icon-button"
                aria-label="关闭详情"
                onClick={() => dialog.current.close()}
              >
                <Icon name="close" />
              </button>
            </div>
            <h2 id="detail-title">{detailRow[0]}</h2>
            <p className="detail-translation">{detailRow[2] || "—"}</p>
            <dl>
              <div>
                <dt>分类</dt>
                <dd>
                  {detailRow[5].map((topic) => labels[topic]).join(" / ") ||
                    "—"}
                </dd>
              </div>
              <div>
                <dt>内容状态</dt>
                <dd>{displayLevels[detailRow[4]]}</dd>
              </div>
              <div>
                <dt>引用</dt>
                <dd>{formats.format(detailRow[3])}</dd>
              </div>
            </dl>
            {detailRow[6] && (
              <p className="translation-audit">
                {detailRow[5].includes("identity/real_person")
                  ? "姓名校对"
                  : detailRow[5].includes("identity/artist")
                    ? "笔名校对"
                    : "译名校对"}
              </p>
            )}
            <div className="detail-actions">
              {mode === "select" && (
                <button
                  onClick={() => {
                    addTags([{ name: detailRow[0], cn: detailRow[2] }]);
                    setDetail(null);
                  }}
                >
                  <Icon name="plus" />
                  添加词条
                </button>
              )}
              {mode === "browse" && <><button
                className="primary-button"
                onClick={() => copy(detailRow[0])}
              >
                <Icon name="copy" />
                复制标签
              </button>
              <button onClick={() => toggleFavorite(detailRow[0])}>
                <Icon name="star" />
                {favorites.includes(detailRow[0]) ? "已收藏" : "收藏"}
              </button>
              </>}
              <a
                href={`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(detailRow[0])}`}
                target="_blank"
                rel="noreferrer"
              >
                Wiki ↗
              </a>
            </div>
          </div>
        )}
      </dialog>
      {toast && (
        <div className="toast" role="status">
          {toast === "已复制" && <Icon name="check" />}
          {toast}
        </div>
      )}
    </div>
  );
}
