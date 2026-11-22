import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// 沿用已有导出流程，只复制当前清单引用的数据，旧快照不进入新网站。
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("dist/data/manifest.json", root), "utf8"),
);
await mkdir(new URL("public/data/", root), { recursive: true });
const files = [
  "search-worker.js",
  "content-policy.js",
  "favicon.svg",
  "DATA-LICENSE.txt",
  ...manifest.chunks.map((file) => `data/${file}`),
  `data/${manifest.classification.file}`,
  `data/${manifest.translations.file}`,
  "data/manifest.json",
];
for (const file of files) {
  // 先复制完整依赖，最后切换清单；已有页面不会读到正在截断写入的文件。
  const temporary = new URL(`public/${file}.${randomUUID()}.tmp`, root);
  await copyFile(
    new URL(`dist/${file}`, root),
    temporary,
  );
  await rename(temporary, new URL(`public/${file}`, root));
}
console.log(`已准备 ${manifest.total.toLocaleString("en-US")} 条词库数据。`);
