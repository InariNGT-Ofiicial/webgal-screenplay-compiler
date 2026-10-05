#!/usr/bin/env python3
"""
extract-docx.py —— 从剧本合订本 docx 提取全文（纯读取，不修改文档）

为什么不用 editor_sdk 的 doc_* 工具：
  doc_resolve_document_structure 的 text_preview 上限是 200 字符，
  而原文档里有超长段落（>200 字），会被截断 ⇒ 提取不完整。
  提取全文属于**数据提取**（docx → 结构化 JSON），直接用 zipfile 解析最可靠。

输出：compiler/mainline-src/script.json
  {
    "meta": { source, extracted_at, total_nodes },
    "nodes": [ {i, type, style, text} ]   # type: Title/Heading/Paragraph
  }
"""

import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

SRC = r'./examples/script.docx'
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, 'mainline-src')
OUT = os.path.join(OUT_DIR, 'script.json')


def para_text(p):
    """提取一个 <w:p> 的全部文本（含软换行）"""
    parts = []
    for node in p.iter():
        tag = node.tag
        if tag == W + 't':
            parts.append(node.text or '')
        elif tag in (W + 'br', W + 'cr'):
            parts.append('\n')
        elif tag == W + 'tab':
            parts.append('\t')
    return ''.join(parts)


def para_style(p):
    """取段落样式名"""
    ppr = p.find(W + 'pPr')
    if ppr is None:
        return ''
    st = ppr.find(W + 'pStyle')
    if st is None:
        return ''
    return st.get(W + 'val') or ''


def outline_level(p):
    """取大纲级别（若样式没给）"""
    ppr = p.find(W + 'pPr')
    if ppr is None:
        return None
    ol = ppr.find(W + 'outlineLvl')
    if ol is None:
        return None
    try:
        return int(ol.get(W + 'val'))
    except (TypeError, ValueError):
        return None


def classify(style, text, lvl):
    s = (style or '').lower()
    if 'title' in s and 'sub' not in s:
        return 'Title'
    if 'subtitle' in s:
        return 'Subtitle'
    m = re.search(r'heading\s*(\d)', s)
    if m:
        return 'Heading' + m.group(1)
    m = re.search(r'标题\s*(\d)', style or '')
    if m:
        return 'Heading' + m.group(1)
    if lvl is not None and 0 <= lvl <= 8:
        return 'Heading' + str(lvl + 1)
    return 'Paragraph'


def main():
    if not os.path.exists(SRC):
        print('找不到源文件：' + SRC)
        sys.exit(1)

    with zipfile.ZipFile(SRC) as z:
        xml = z.read('word/document.xml')
    root = ET.fromstring(xml)

    body = root.find(W + 'body')
    if body is None:
        print('文档结构异常：没有 body')
        sys.exit(1)

    nodes = []
    for p in body.iter(W + 'p'):
        text = para_text(p)
        # 清理：零宽字符、BOM、行首尾空白（保留内部换行）
        text = re.sub(r'[\u200b-\u200d\u2060\ufeff\u180e\u00ad]', '', text)
        text = text.replace('\r', '')
        stripped = text.strip()
        style = para_style(p)
        lvl = outline_level(p)
        typ = classify(style, stripped, lvl)
        if not stripped and typ == 'Paragraph':
            continue  # 丢空段
        nodes.append({
            'i': len(nodes),
            'type': typ,
            'style': style,
            'text': stripped,
        })

    os.makedirs(OUT_DIR, exist_ok=True)
    payload = {
        'meta': {
            'source': SRC,
            'total_nodes': len(nodes),
            'headings': sum(1 for n in nodes if n['type'].startswith('Heading')),
            'paragraphs': sum(1 for n in nodes if n['type'] == 'Paragraph'),
        },
        'nodes': nodes,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print('✓ 提取完成：' + OUT)
    print('  节点 ' + str(len(nodes)) + '（标题 ' + str(payload['meta']['headings']) +
          ' / 正文 ' + str(payload['meta']['paragraphs']) + '）')
    print('')
    print('  前 8 条：')
    for n in nodes[:8]:
        print('    [' + n['type'] + '] ' + n['text'][:70])


if __name__ == '__main__':
    main()
