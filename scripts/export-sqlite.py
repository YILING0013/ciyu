"""根据当前网页快照生成同版本的词屿 SQLite。"""

import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile

ROOT = Path(__file__).resolve().parent.parent
STATUSES = {'normal', 'sensitive', 'nsfw'}

SCHEMA = """
CREATE TABLE tags (
  name TEXT NOT NULL PRIMARY KEY,
  category INTEGER NOT NULL CHECK (category IN (0,1,3,4,5)),
  cn_name TEXT,
  post_count INTEGER NOT NULL CHECK (post_count >= 0)
);
CREATE TABLE classifications (
  name TEXT NOT NULL PRIMARY KEY REFERENCES tags(name),
  content_status TEXT NOT NULL CHECK (content_status IN ('normal','sensitive','nsfw'))
);
CREATE TABLE taxonomy_topics (
  topic TEXT NOT NULL PRIMARY KEY,
  parent TEXT REFERENCES taxonomy_topics(topic),
  label TEXT NOT NULL
);
CREATE TABLE tag_topics (
  name TEXT NOT NULL REFERENCES classifications(name),
  position INTEGER NOT NULL,
  topic TEXT NOT NULL REFERENCES taxonomy_topics(topic),
  PRIMARY KEY (name, position),
  UNIQUE (name, topic)
) WITHOUT ROWID;
CREATE TABLE translation_reviews (
  name TEXT NOT NULL PRIMARY KEY REFERENCES classifications(name),
  corrected_cn_name TEXT NOT NULL
);
CREATE TABLE export_metadata (
  key TEXT NOT NULL PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE INDEX tag_topics_by_topic ON tag_topics(topic, name);
CREATE INDEX tags_by_popularity ON tags(post_count DESC, name);
CREATE INDEX classifications_by_status ON classifications(content_status, name);
CREATE VIEW effective_tags AS
  SELECT t.name, t.category AS source_category, t.cn_name AS original_cn_name,
         coalesce(r.corrected_cn_name, t.cn_name) AS effective_cn_name, t.post_count, c.content_status
  FROM tags t JOIN classifications c USING (name)
  LEFT JOIN translation_reviews r USING (name);
CREATE VIEW normal_tags AS SELECT * FROM effective_tags WHERE content_status = 'normal';
"""


def export_sqlite(data_dir, output):
    """验证静态数据并生成一个 SQLite 文件。

    Args:
        data_dir: 包含当前 manifest.json 及全部引用文件的目录。
        output: 新 SQLite 的绝对路径。
    Returns:
        包含词条、校对记录和主题关系数量的字典。
    """
    manifest_bytes = (data_dir / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    snapshots = {}
    for kind in ('classification', 'translations'):
        pointer = manifest[kind]
        path = data_dir / pointer['file']
        if path.parent != data_dir or path.name != pointer['file']:
            raise ValueError(f'非法快照文件名：{pointer["file"]}')
        content = path.read_bytes()
        snapshot = json.loads(content)
        if (hashlib.sha256(content).hexdigest() != pointer['sha256']
                or snapshot['source_commit'] != manifest['commit']
                or len(snapshot['records']) != pointer['count']):
            raise ValueError(f'{kind} 快照指纹、来源或记录数不一致')
        snapshots[kind] = snapshot
    rows = []
    for filename in manifest['chunks']:
        path = data_dir / filename
        content = path.read_bytes()
        if path.parent != data_dir or filename != (
                f'tags-{len(rows) // 12000:02d}-{hashlib.sha256(content).hexdigest()[:16]}.json'):
            raise ValueError(f'分片文件名或指纹不匹配：{filename}')
        rows.extend(json.loads(content))
    tags = {row[0]: row[2] for row in rows}
    classes = snapshots['classification']['records']
    translations = snapshots['translations']
    if len(rows) != manifest['total'] or len(tags) != len(rows) or tags.keys() != classes.keys():
        raise ValueError('词条和分类须逐条对应')
    if (translations['schema_version'] != 2 or translations['review_status'] != 'ai_draft'
            or translations['human_reviewed'] is not False):
        raise ValueError('不支持的译文快照格式')
    corrections = translations['records']
    if any(name not in tags or not isinstance(value, str) or not value.strip() or value == tags[name]
           for name, value in corrections.items()):
        raise ValueError('译文纠错与词条不匹配')
    taxonomy = snapshots['classification']['taxonomy']
    parents = [(parent, None, group['label']) for parent, group in taxonomy.items()]
    children = [(f'{parent}/{child}', parent, label) for parent, group in taxonomy.items()
                for child, label in group['children'].items()]
    metadata = {
        'source_commit': manifest['commit'],
        'source_repository': manifest['repository'],
        'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'classification_sha256': manifest['classification']['sha256'],
        'translations_sha256': manifest['translations']['sha256'],
        'review_status': 'ai_draft',
        'human_reviewed': False,
    }
    if output.exists() or output.is_symlink():
        raise FileExistsError(f'目标已存在：{output}')
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix=f'.{output.name}.', suffix='.tmp',
                                     delete=False) as stream:
        temporary = Path(stream.name)
    with closing(sqlite3.connect(temporary)) as connection:
        connection.execute('PRAGMA foreign_keys = ON')
        connection.executescript(SCHEMA)
        with connection:
            connection.executemany('INSERT INTO tags VALUES (?,?,?,?)', rows)
            connection.executemany('INSERT INTO classifications VALUES (?,?)',
                                   ((name, record[0]) for name, record in classes.items()))
            connection.executemany('INSERT INTO taxonomy_topics VALUES (?,?,?)', parents + children)
            connection.executemany('INSERT INTO tag_topics VALUES (?,?,?)',
                                   ((name, index, topic) for name, record in classes.items()
                                    for index, topic in enumerate(record[1])))
            connection.executemany('INSERT INTO translation_reviews VALUES (?,?)', corrections.items())
            connection.executemany('INSERT INTO export_metadata VALUES (?,?)',
                                   ((key, json.dumps(value, ensure_ascii=False)) for key, value in metadata.items()))
        if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite 完整性校验失败')
        ordered_topics = connection.execute('SELECT COUNT(*) FROM tag_topics').fetchone()[0]
    # 完整导出后才发布；同名文件由其他进程先创建时，硬链接创建会失败。
    output.hardlink_to(temporary)
    temporary.unlink()
    return {'tags': len(rows), 'corrections': len(corrections), 'tag_topics': ordered_topics, 'output': str(output)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='新文件路径，父目录须已存在')
    args = parser.parse_args()
    print(json.dumps(export_sqlite(ROOT / 'dist/data', args.output.absolute()), ensure_ascii=False))
