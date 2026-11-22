const paths = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  up: "m6 14 6-6 6 6",
  down: "m6 10 6 6 6-6",
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  table: "M3 4h18v16H3ZM3 9h18M3 14h18M10 4v16",
  pill: "M8 6h8a6 6 0 0 1 0 12H8A6 6 0 0 1 8 6Z",
  search: "m21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  hash: "M5 9h14M4 15h14M11 3 7 21M17 3l-4 18",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z",
  copy: "M9 9h11v12H9zM15 9V3H3v12h6",
  check: "m5 12 4 4L19 6",
  chevron: "m9 5 7 7-7 7",
  close: "m6 6 12 12M6 18 18 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  appearance: "M20 21a8 8 0 0 0-16 0M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  clothing: "m8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0",
  accessories: "m12 3 9 7-9 11L3 10ZM3 10h18M8 3l-2 7 6 11 6-11-2-7",
  pose: "m7 21 5-7 5 7M5 7l7 4 7-4M12 7v7M14 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  expression:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 14s1 3 4 3 4-3 4-3M8 9h.01M16 9h.01",
  scene: "M3 20 9 8l4 7 3-5 5 10ZM18 5h.01",
  composition: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 8h8v8H8z",
  lighting:
    "M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  style: "m14 5 5 5M4 20l4-1L21 6l-3-3L5 16Z",
  objects: "m12 3 9 5v9l-9 5-9-5V8ZM3 8l9 5 9-5M12 13v9",
  identity: "M3 5h18v14H3ZM6.5 15.5a3.5 3.5 0 0 1 7 0M12 9.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM16 10h2M16 14h2",
  franchise: "M5 3h14a1 1 0 0 1 1 1v15H7a2 2 0 0 0 0 4h13M4 21V5a2 2 0 0 1 2-2M9 7h7M9 11h5",
  pending: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  settings: "M4 6h5m4 0h7M4 12h9m4 0h3M4 18h3m4 0h9M9 4v4m4 2v4m-6 2v4",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6M12 7h.01",
  trash: "M4 7h16M6 7l1 14h10l1-14M9 7V4h6v3M10 10v7M14 10v7",
};

/**
 * 绘制界面共用的线性图标。
 * @param {object} props 图标名称与可选样式类。
 * @returns {React.ReactNode} 对辅助技术隐藏的 SVG。
 */
export default function Icon({ name, className = "" }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
