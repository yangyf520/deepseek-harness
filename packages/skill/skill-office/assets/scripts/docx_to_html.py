#!/usr/bin/env python3
"""Convert a DOCX document to HTML (preserving structure) and plain text.

Usage:
    python docx_to_html.py <input.docx> <output_base>

Outputs:
    <output_base>.html  - HTML rendering with headings, paragraph alignment, list
                          numbers, merged table cells, styled runs, and tables
    <output_base>.txt   - Plain text extraction (innerText equivalent), with the
                          same rendered list numbers as the HTML

Requires: python-docx (bundled via load_workspace_dependencies)
"""
import sys
import os
import re
from html import escape

try:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
except ImportError:
    print("Error: python-docx not installed. Call load_workspace_dependencies first.", file=sys.stderr)
    sys.exit(1)


HTML_STYLE = (
    '<style>'
    'table{border-collapse:collapse;width:100%;margin:10px 0}'
    'th,td{border:1px solid #ccc;padding:6px 10px;font-size:14px;vertical-align:top}'
    'th{background:#f5f5f5}'
    'p.li{margin:0.3em 0;padding-left:1.6em;text-indent:-1.6em}'
    '</style>'
)


def iter_block_items(parent):
    """Yield body paragraphs and tables in document order."""
    if hasattr(parent, 'element'):
        body = parent.element.body if hasattr(parent.element, 'body') else parent.element
    else:
        body = parent
    for child in body:
        if isinstance(child, CT_P):
            yield Paragraph(child, parent)
        elif isinstance(child, CT_Tbl):
            yield Table(child, parent)


def numbering_formats(doc):
    """Map numId to (level-0 lvlText, start number, numFmt) from the numbering part."""
    try:
        numbering = doc.part.numbering_part.element
    except (KeyError, NotImplementedError):
        return {}
    abstract = {}
    for element in numbering.findall(qn('w:abstractNum')):
        for lvl in element.findall(qn('w:lvl')):
            if lvl.get(qn('w:ilvl')) not in (None, '0'):
                continue
            text = lvl.find(qn('w:lvlText'))
            start = lvl.find(qn('w:start'))
            fmt = lvl.find(qn('w:numFmt'))
            abstract[element.get(qn('w:abstractNumId'))] = (
                text.get(qn('w:val')) if text is not None else '',
                int(start.get(qn('w:val'))) if start is not None else 1,
                fmt.get(qn('w:val')) if fmt is not None else 'decimal',
            )
            break
    formats = {}
    for element in numbering.findall(qn('w:num')):
        reference = element.find(qn('w:abstractNumId'))
        spec = abstract.get(reference.get(qn('w:val'))) if reference is not None else None
        if spec is not None:
            formats[element.get(qn('w:numId'))] = spec
    return formats


def number_prefix(para, formats, counters):
    """Return the list number Word renders for a numbered paragraph, else ''."""
    pPr = para._p.pPr
    reference = pPr.numPr.numId if pPr is not None and pPr.numPr is not None else None
    if reference is None:
        return ''
    num_id = str(reference.val)
    spec = formats.get(num_id)
    if spec is None:
        return ''
    lvl_text, start, fmt = spec
    if fmt == 'none':
        return ''
    counters[num_id] = counters.get(num_id, start - 1) + 1
    return lvl_text.replace('%1', str(counters[num_id])).strip()


def runs_inner(p_element):
    """Render a paragraph element's runs as HTML, keeping bold and italic."""
    parts = []
    for run in p_element.iter(qn('w:r')):
        text = ''.join(node.text or '' for node in run.iter(qn('w:t')))
        if text == '':
            continue
        html = escape(text)
        rPr = run.find(qn('w:rPr'))
        if rPr is not None:
            bold = rPr.find(qn('w:b'))
            italic = rPr.find(qn('w:i'))
            if bold is not None and bold.get(qn('w:val')) not in ('0', 'false'):
                html = f'<strong>{html}</strong>'
            if italic is not None and italic.get(qn('w:val')) not in ('0', 'false'):
                html = f'<em>{html}</em>'
        parts.append(html)
    return ''.join(parts)


def run_size(p_element):
    """Return the largest run font size in points, or 0."""
    sizes = []
    for node in p_element.iter(qn('w:sz')):
        try:
            sizes.append(int(node.get(qn('w:val'))) / 2)
        except (TypeError, ValueError):
            continue
    return max(sizes, default=0)


def heading_level(para, size):
    """Return heading level (1-9) from the paragraph style or run size, else 0."""
    style_name = para.style.name if para.style is not None else ''
    match = re.match(r'(?i)(?:heading|标题)\s*(\d)', style_name)
    if match is not None:
        return int(match.group(1))
    if style_name == 'Title' or style_name == '标题':
        return 1
    if size >= 20:
        return 1
    if size >= 15:
        return 2
    if size >= 13:
        return 3
    return 0


def alignment_attr(para):
    """Return the inline style for a paragraph's non-default alignment, else ''."""
    if para.alignment == WD_ALIGN_PARAGRAPH.CENTER:
        return ' style="text-align:center"'
    if para.alignment == WD_ALIGN_PARAGRAPH.RIGHT:
        return ' style="text-align:right"'
    if para.alignment == WD_ALIGN_PARAGRAPH.JUSTIFY:
        return ' style="text-align:justify"'
    return ''


def paragraph_to_html(para, prefix):
    """Render one body paragraph as HTML with its heading level, number, and alignment."""
    p_element = para._p
    inner = runs_inner(p_element)
    if prefix:
        inner = f'{escape(prefix)} {inner}'.strip()
    level = heading_level(para, run_size(p_element))
    attr = alignment_attr(para)
    if level > 0:
        return f'<h{level}{attr}>{inner}</h{level}>'
    if prefix:
        return f'<p class="li"{attr}>{inner}</p>'
    return f'<p{attr}>{inner}</p>'


def cell_inner(tc):
    """Render a table cell's paragraphs, separated by line breaks."""
    parts = []
    for para in tc.iterchildren(qn('w:p')):
        inner = runs_inner(para).strip()
        if inner != '':
            parts.append(inner)
    return '<br>'.join(parts)


def table_to_html(table):
    """Convert a docx table to HTML, keeping the header row and vertical merges."""
    open_cells = {}
    rows = []
    for index, tr in enumerate(table._tbl.findall(qn('w:tr'))):
        cells = []
        column = 0
        for tc in tr.findall(qn('w:tc')):
            tcPr = tc.find(qn('w:tcPr'))
            span = 1
            merge = None
            if tcPr is not None:
                grid_span = tcPr.find(qn('w:gridSpan'))
                if grid_span is not None:
                    span = int(grid_span.get(qn('w:val')) or 1)
                merge_element = tcPr.find(qn('w:vMerge'))
                if merge_element is not None:
                    merge = merge_element.get(qn('w:val')) or 'continue'
            if merge == 'continue':
                opened = open_cells.get(column)
                if opened is not None:
                    opened['span'] += 1
                column += span
                continue
            cell = {'html': cell_inner(tc), 'span': 1, 'tag': 'th' if index == 0 else 'td'}
            if merge == 'restart':
                open_cells[column] = cell
            else:
                open_cells.pop(column, None)
            cells.append(cell)
            column += span
        rows.append(cells)
    rendered_rows = []
    for cells in rows:
        if not cells:
            continue
        rendered = []
        for cell in cells:
            tag = cell['tag']
            rowspan = f' rowspan="{cell["span"]}"' if cell['span'] > 1 else ''
            rendered.append(f'<{tag}{rowspan}>{cell["html"]}</{tag}>')
        rendered_rows.append('<tr>' + ''.join(rendered) + '</tr>')
    return '<table>' + ''.join(rendered_rows) + '</table>'


def table_to_text(table):
    """Convert a docx table to plain text, one row per line."""
    lines = []
    for row in table.rows:
        cells = [cell.text.strip() for cell in row.cells]
        lines.append(' | '.join(cells))
    return '\n'.join(lines)


def convert(docx_path, output_base):
    """Convert DOCX to HTML and plain text."""
    doc = Document(docx_path)
    formats = numbering_formats(doc)
    counters = {}

    html_parts = [HTML_STYLE]
    text_parts = []

    for block in iter_block_items(doc):
        if isinstance(block, Paragraph):
            text = block.text.strip()
            if not text:
                continue
            prefix = number_prefix(block, formats, counters)
            html_parts.append(paragraph_to_html(block, prefix))
            text_parts.append(f'{prefix} {text}'.strip() if prefix else text)
        elif isinstance(block, Table):
            html_parts.append(table_to_html(block))
            text_parts.append(table_to_text(block))

    html_content = '<meta charset="utf-8">\n' + '\n'.join(html_parts) + '\n'
    text_content = '\n'.join(text_parts) + '\n'

    html_path = f'{output_base}.html'
    text_path = f'{output_base}.txt'

    os.makedirs(os.path.dirname(output_base) or '.', exist_ok=True)

    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    with open(text_path, 'w', encoding='utf-8') as f:
        f.write(text_content)

    print(f'Generated: {html_path} ({len(html_content)} bytes)')
    print(f'Generated: {text_path} ({len(text_content)} bytes)')
    return html_path, text_path


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f'Usage: {sys.argv[0]} <input.docx> <output_base>', file=sys.stderr)
        print(f'Example: {sys.argv[0]} document.docx work/document', file=sys.stderr)
        sys.exit(1)

    docx_path = sys.argv[1]
    output_base = sys.argv[2]

    if not os.path.exists(docx_path):
        print(f'Error: {docx_path} not found', file=sys.stderr)
        sys.exit(1)

    convert(docx_path, output_base)
