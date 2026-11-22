# 词屿 · Danbooru Tag Atlas

词屿是 Danbooru 中英文标签图鉴和提示词工作台。支持分类与作品筛选、搜索联想、收藏、标签复制和 NovelAI／Stable Diffusion 数字加权。工作区保存在浏览器本地。

## 运行与部署

需要 Node.js 20.9+ 和 npm。在项目根目录运行：

```sh
npm ci
npm test
npm run build
```

将生成的 `out/` 部署到静态站点的域名根目录，完整上传 `_next/` 和 `data/`。站点通过 Web Worker 在浏览器中建立索引。以生产域名提供 HTTPS，本地可使用环回地址。

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory out
```

端口 4173 空闲时启动预览，访问 `http://127.0.0.1:4173/`。源码调试可运行 `npm run dev`。更新已有站点时先上传新数据文件，再切换 `data/manifest.json`，对清单使用重新验证缓存策略。

## 数据和 SQLite

当前词库包含 **335,971** 个词条和 **14,917** 条译名纠正。词义分类为普通、敏感和 NSFW，默认只显示普通标签。分类和校对是 AI 草稿，标签词义无法决定带有该词条的图片内容。

网页数据位于 `dist/data/`。使用 Python 3.10+ 从同一份快照生成 SQLite：

```sh
python3 scripts/export-sqlite.py ciyu.sqlite
```

`effective_tags` 提供生效中文名、英文名、上游类别、引用量和内容分区；`normal_tags` 仅提供普通标签。主题关系位于 `tag_topics` 和 `taxonomy_topics`。`export_metadata` 保存源提交和网页快照指纹，便于核对部署版本。已撤下中文名的标签仍可通过英文搜索。

## 来源与许可

项目代码采用 [MIT 许可](LICENSE)。基础词库来自 [Danbooru 中文标签翻译表](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table)，原始许可在 [DATA-LICENSE.txt](dist/DATA-LICENSE.txt)，源版本见 `dist/data/manifest.json`。
