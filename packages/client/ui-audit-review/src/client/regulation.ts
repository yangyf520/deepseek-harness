/**
 * Regulation basis for audit findings: split the citations a finding carries off its prose, resolve
 * them to wiki pages, and load the cited provision's text, so a reviewer can read the rule behind a
 * finding without leaving the card. An issue may name a regulation in full or in the short form it
 * happens to use, and may name it without an article; the wiki index resolves either form, and a
 * citation the wiki does not carry stays hidden rather than inventing a source.
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReadFileBytes } from './ReviewPanel.tsx'

/** Wiki index the audit reads its regulation pages from; its links name those pages. */
const WIKI_INDEX = '.wiki/wiki/_index.md'

/** Directory the wiki index links resolve against. */
const WIKI_BASE = '.wiki/wiki/'

/** Trailing citation clause `audit_write` requires of a finding that rests on a regulation. */
const BASIS_CLAUSE = /依据[：:]\s*([^\n]+)$/m

/** A `《law》` mention with the article references that follow it, when the issue names any. */
const BRACKETED = /《([^》]{2,80})》\s*((?:第\s*[〇零一二三四五六七八九十百0-9]+\s*条\s*[、，和]?\s*)+)?/g

/** One article reference: `第十八条`, `第 9 条`. */
const ARTICLE = /第\s*[〇零一二三四五六七八九十百0-9]+\s*条/g

/** The numeral of an article reference: `第十八条` → `十八`, `第 9 条` → `9`. */
const ARTICLE_NUMERAL = /第\s*([〇零一二三四五六七八九十百0-9]+)\s*条/

/**
 * Article reference chain on one line: the `第` may open a single article or a range and list such
 * as `第二十八至三十二条` and `第九、十条`, where the further numbers stand without it.
 */
const ARTICLE_CHAIN =
  /第\s*([〇零一二三四五六七八九十百0-9]+)((?:\s*[、，,和至]\s*(?:第\s*)?[〇零一二三四五六七八九十百0-9]+)*)\s*条/g

/** One separator inside a reference chain and the numeral it carries. */
const CHAIN_MEMBER = /([、，,和至])\s*(?:第\s*)?([〇零一二三四五六七八九十百0-9]+)/g

/** Line that starts with an article reference, so the line carries the provision itself. */
const PROVISION_START = /^(?:[-*]\s*)?(?:\*\*)?第/

/** Heading whose section points at other pages, where an article name is a reference, not the provision. */
const REFERENCES = /相关页面|相关法规|参见/

/** Characters that end the words standing before a bare article reference. */
const MENTION_BREAK = /[，。；：、（）()「」“”"'《》？！!?\s]/

/** Longest article range a heading may span, in articles. */
const MAX_RANGE = 100

/** Longest provision block the card shows, in lines. */
const MAX_BLOCK_LINES = 24

/** Longest page summary the card shows for a citation that names no article, in lines. */
const MAX_SUMMARY_LINES = 40

/** Page lines that state where the page came from rather than the regulation itself. */
const SOURCE_LINE = /^\s*来源[：:]/

/** Words searched before a bare article reference for the regulation they cite. */
const MAX_MENTION_CHARS = 16

/** Shortest name a citation may resolve by, so a stray `办法` finds nothing. */
const MIN_MENTION_CHARS = 3

/** One regulation citation a finding carries, as its issue writes it. */
export interface RegulationCitation {
  /** Regulation name as cited: a `《…》` title, or the words standing before an article reference. */
  law: string
  /** Article reference as cited, absent when the issue names only the regulation. */
  article?: string
}

/** A citation matched to the wiki page that carries it. */
export interface ResolvedCitation {
  /** Article reference the citation named, if any. */
  article?: string
  /** Workspace path of the regulation page. */
  path: string
  /** Page title, which names the regulation in full. */
  title: string
}

/** The wiki text behind one resolved citation. */
export interface RegulationArticle {
  /** Wiki page the text was read from. */
  path: string
  /** Page title, so the card shows where the text comes from. */
  title: string
  /** Provision text, with markdown emphasis, links, and heading marks removed. */
  text: string
}

/** One page link the wiki index carries. */
interface IndexLink {
  path: string
  title: string
}

/** Wiki index links per session, so every card reuses one read of the index. */
const indexCache = new Map<string, Promise<IndexLink[]>>()

/**
 * Split the citations off a finding's issue, so the prose stands on its own and the regulations it
 * rests on render as their own line. The clause `audit_write` requires is stripped when it carries a
 * citation; a finding that cites regulations inside its prose keeps that prose unchanged.
 * @param issue - Issue prose as recorded by `audit_write`, with its level prefix already removed.
 * @returns the prose, plus every citation the issue carries.
 */
export function splitBasis(issue: string): { prose: string; citations: RegulationCitation[] } {
  const clause = BASIS_CLAUSE.exec(issue)
  const cited = clause === null ? [] : citationsIn(clause[1] ?? '')
  const prose = clause !== null && cited.length > 0
    ? issue.slice(0, clause.index).replace(/[\s；;，,。]+$/, '')
    : issue
  return { prose, citations: dedupe([...cited, ...citationsIn(prose)]) }
}

/** One citation as the card displays it. */
export function citationLabel(resolved: ResolvedCitation): string {
  return `《${resolved.title}》${resolved.article ?? ''}`
}

/**
 * Match citations to wiki pages, dropping those the wiki does not carry.
 * @param readFileBytes - Workspace file reader supplied by the host.
 * @param sessionId - Session whose workspace holds the wiki.
 * @param citations - Citations as the finding wrote them.
 * @returns one entry per distinct page and article, in citation order.
 */
export async function resolveBasis(
  readFileBytes: ReadFileBytes,
  sessionId: SessionId,
  citations: readonly RegulationCitation[],
): Promise<ResolvedCitation[]> {
  if (citations.length === 0) return []
  const links = await wikiLinks(readFileBytes, sessionId)
  const resolved: ResolvedCitation[] = []
  for (const citation of citations) {
    const page = matchPage(links, citation.law)
    if (page === null) continue
    if (resolved.some(entry => entry.path === page.path && entry.article === citation.article)) continue
    resolved.push({ ...(citation.article === undefined ? {} : { article: citation.article }), path: page.path, title: page.title })
  }
  return resolved
}

/**
 * Read the text behind one resolved citation: the cited provision, or the page summary when the
 * citation names no article.
 * @param readFileBytes - Workspace file reader supplied by the host.
 * @param sessionId - Session whose workspace holds the wiki.
 * @param resolved - Citation already matched to a page.
 * @returns the text, or null when the page is unreadable or lacks the cited article.
 */
export async function loadRegulationArticle(
  readFileBytes: ReadFileBytes,
  sessionId: SessionId,
  resolved: ResolvedCitation,
): Promise<RegulationArticle | null> {
  const page = await readText(readFileBytes, sessionId, resolved.path)
  if (page === null) return null
  const text = resolved.article === undefined
    ? summarizePage(page)
    : extractArticle(page, resolved.article)
  if (text === null || text === '') return null
  return { path: resolved.path, title: resolved.title, text }
}

/** Every citation one text carries, including a regulation named without its `《》`. */
function citationsIn(text: string): RegulationCitation[] {
  const citations: RegulationCitation[] = []
  for (const match of text.matchAll(BRACKETED)) {
    const law = match[1] ?? ''
    if (law === '') continue
    const articles = [...(match[2] ?? '').matchAll(ARTICLE)]
    if (articles.length === 0) citations.push({ law })
    for (const article of articles) citations.push({ law, article: article[0].replace(/\s+/g, '') })
  }
  // Bracketed mentions are consumed, so a bare article reference is read with the words before it.
  const masked = text.replace(BRACKETED, span => ' '.repeat(span.length))
  for (const mention of masked.matchAll(ARTICLE)) {
    const before = masked.slice(Math.max(0, mention.index - MAX_MENTION_CHARS), mention.index)
    const words = (before.split(MENTION_BREAK).pop() ?? '').replace(/[的之]+$/, '')
    if (words.length < MIN_MENTION_CHARS) continue
    citations.push({ law: words, article: mention[0].replace(/\s+/g, '') })
  }
  return citations
}

/** The same citations without repeats of one page and article. */
function dedupe(citations: readonly RegulationCitation[]): RegulationCitation[] {
  const seen = new Set<string>()
  const unique: RegulationCitation[] = []
  for (const citation of citations) {
    const key = `${citation.law}|${citation.article ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(citation)
  }
  return unique
}

/** Wiki index links for this session, read once and shared by every card. */
function wikiLinks(readFileBytes: ReadFileBytes, sessionId: SessionId): Promise<IndexLink[]> {
  const key = String(sessionId)
  const cached = indexCache.get(key)
  if (cached !== undefined) return cached
  const loading = (async () => {
    const text = await readText(readFileBytes, sessionId, WIKI_INDEX)
    return text === null ? [] : indexLinks(text)
  })()
  indexCache.set(key, loading)
  return loading
}

/** Decode a workspace file as UTF-8, or null when it is absent or unreadable. */
async function readText(
  readFileBytes: ReadFileBytes,
  sessionId: SessionId,
  path: string,
): Promise<string | null> {
  try {
    return new TextDecoder().decode(await readFileBytes(sessionId, path))
  } catch {
    // The wiki is optional workspace content: an absent page leaves the citation without text.
    return null
  }
}

/** Every page link the index holds, as absolute workspace paths, in index order. */
function indexLinks(index: string): IndexLink[] {
  const links: IndexLink[] = []
  for (const match of index.matchAll(/\[([^\]]+)\]\(([^)\s]+\.md)\)/g)) {
    links.push({ path: resolveTarget(match[2] ?? ''), title: match[1] ?? '' })
  }
  for (const match of index.matchAll(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g)) {
    links.push({ path: resolveTarget(match[1] ?? ''), title: match[2] ?? match[1] ?? '' })
  }
  return links
}

/** Resolve one index link target against the wiki directory, leaving absolute paths alone. */
function resolveTarget(target: string): string {
  const trimmed = target.replace(/^\.\//, '')
  return trimmed.startsWith('/') || trimmed.includes('.wiki/') ? trimmed : `${WIKI_BASE}${trimmed}`
}

/**
 * Match a cited name to a page. The words before an article reference may open with a verb, so the
 * whole mention is matched by containment against the names a page may be cited by, and any tail of
 * it by those names' leading letters, which admits `个保法` for `个人信息保护法` while leaving
 * `未成年人保护法` unmatched. Containment stays off the tails, where a fragment such as `保护法`
 * would otherwise pick the wrong regulation.
 * @param links - Wiki index links.
 * @param mention - Regulation name as cited.
 * @returns the matching link, or null when no page carries this name.
 */
function matchPage(links: readonly IndexLink[], mention: string): IndexLink | null {
  const pages = links.map(link => ({ link, names: citeNames(link.title).map(normalizeName) }))
  for (let start = 0; start + MIN_MENTION_CHARS <= mention.length; start += 1) {
    const wanted = normalizeName(mention.slice(start))
    if (wanted.length < MIN_MENTION_CHARS) break
    if (start === 0) {
      const contained = pages.find(page =>
        page.names.some(name => name.includes(wanted) || wanted.includes(name)))
      if (contained !== undefined) return contained.link
    }
    const initial = wanted[0]
    if (initial === undefined) break
    const spelled = pages.find(page =>
      page.names.some(name => name.startsWith(initial) && isOrdered(wanted, name)))
    if (spelled !== undefined) return spelled.link
  }
  return null
}

/**
 * The names a regulation title may be cited by: the title, the same without a `中华人民共和国`
 * prefix or an `人工智能` prefix, and those condensed from `服务管理暂行办法` to `办法`.
 * @param title - Page title.
 * @returns the names, longest first.
 */
function citeNames(title: string): string[] {
  const names = new Set<string>([title])
  for (const name of [...names]) {
    names.add(name.replace(/^中华人民共和国/, '').replace(/（试行）$/, ''))
    names.add(name.replace(/^人工智能/, ''))
    for (const variant of [name, name.replace(/^人工智能/, '')]) {
      names.add(variant.replace(/服务管理(暂)?行办法$/, '办法').replace(/(暂)?行办法$/, '办法'))
    }
  }
  return [...names].filter(name => name !== '').sort((left, right) => right.length - left.length)
}

/** Whether every character of `needle` occurs in `haystack` in the same order. */
function isOrdered(needle: string, haystack: string): boolean {
  let at = 0
  for (const char of haystack) {
    if (char === needle[at]) at += 1
    if (at === needle.length) return true
  }
  return needle.length === 0
}

/** Compare regulation names by their letters and digits, ignoring brackets, spaces, and dashes. */
function normalizeName(name: string): string {
  return name.replace(/[《》〈〉()（）\s·—–-]/g, '')
}

/**
 * Locate one article inside a wiki page: the provision line that starts with the reference, else the
 * section heading whose range covers it, else any line that mentions it. Cross-reference sections
 * stay out of the fallback, because naming an article is not carrying its text.
 * @param page - Wiki page text.
 * @param article - Article reference as cited.
 * @returns the provision block with its nearest preceding heading, or null when the page lacks it.
 */
function extractArticle(page: string, article: string): string | null {
  const numeral = ARTICLE_NUMERAL.exec(article)?.[1]
  if (numeral === undefined) return null
  const wanted = numeralValue(numeral)
  const lines = page.split('\n')
  const context: string[] = []
  const provisions: number[] = []
  const sections: number[] = []
  const mentions: number[] = []
  let heading = ''
  let references = false
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    if (line === undefined) break
    context.push(heading)
    if (line.startsWith('#')) {
      references = REFERENCES.test(line)
      heading = line
      if (!references && coversArticle(line, wanted)) sections.push(at)
      continue
    }
    if (references || !coversArticle(line, wanted)) continue
    if (PROVISION_START.test(line)) provisions.push(at)
    else mentions.push(at)
  }
  const chosen = provisions[0] ?? sections[0] ?? mentions[0]
  if (chosen === undefined) return null
  const chosenLine = lines[chosen]
  if (chosenLine === undefined) return null
  const isHeading = chosenLine.startsWith('#')
  const block = isHeading ? collectSection(lines, chosen) : collectLine(lines, chosen)
  const parts = isHeading ? block : [context[chosen] ?? '', ...block]
  return flattenMarkdown(parts.filter(part => part !== '').join('\n'))
}

/**
 * Summarize a regulation page for a citation that names no article: the page up to its
 * cross-reference section, which points at other pages instead of carrying this regulation. The
 * heading repeats the title the card heads the block with, and a source line records where the page
 * came from, so neither belongs in the text.
 * @param page - Wiki page text.
 * @returns the summary text.
 */
function summarizePage(page: string): string {
  const lines: string[] = []
  for (const line of page.split('\n')) {
    if (line.startsWith('#') && REFERENCES.test(line)) break
    if (SOURCE_LINE.test(line)) continue
    if (lines.length === 0 && line.startsWith('# ')) continue
    lines.push(line)
    if (lines.length >= MAX_SUMMARY_LINES) break
  }
  return flattenMarkdown(lines.join('\n'))
}

/** Chinese numeral digits, for the article numbers wiki pages write in Chinese. */
const DIGITS: Record<string, number> = {
  '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}

/**
 * The article number a numeral denotes, reading 十 and 百 as unit positions: `十八` → 18,
 * `二十八` → 28, `一百零一` → 101.
 * @param numeral - Numeral text from an article reference.
 * @returns the number, or 0 when the text holds no recognizable digit.
 */
function numeralValue(numeral: string): number {
  if (/^[0-9]+$/.test(numeral)) return Number(numeral)
  let total = 0
  let digit = 0
  for (const char of numeral) {
    const value = DIGITS[char]
    if (value !== undefined) {
      digit = value
      continue
    }
    const unit = char === '十' ? 10 : char === '百' ? 100 : 0
    if (unit === 0) continue
    total += (digit === 0 ? 1 : digit) * unit
    digit = 0
  }
  return total + digit
}

/**
 * Every article number one line references: `（第九、十条）` → 9 and 10, `（第二十八至三十二条）`
 * → 28 through 32. A reference must reach its 条, so an ordinal such as `第十三届` names none.
 * @param line - Line from a wiki page.
 * @returns the referenced article numbers, in line order.
 */
function articleValues(line: string): number[] {
  const values: number[] = []
  for (const chain of line.matchAll(ARTICLE_CHAIN)) {
    values.push(numeralValue(chain[1] ?? ''))
    for (const member of (chain[2] ?? '').matchAll(CHAIN_MEMBER)) {
      const value = numeralValue(member[2] ?? '')
      const previous = values.at(-1)
      if (previous === undefined) continue
      if (member[1] === '至' && value > previous && value - previous <= MAX_RANGE) {
        for (let at = previous + 1; at <= value; at += 1) values.push(at)
        continue
      }
      values.push(value)
    }
  }
  return values
}

/** Whether one line references this article number. */
function coversArticle(line: string, wanted: number): boolean {
  return articleValues(line).includes(wanted)
}

/** The line at `start` plus the lines that continue it, stopped by a blank line or a new reference. */
function collectLine(lines: string[], start: number): string[] {
  const head = lines[start]
  if (head === undefined) return []
  const block = [head]
  for (let at = start + 1; at < lines.length && block.length < 3; at += 1) {
    const line = lines[at]
    if (line === undefined || line.trim() === '' || line.startsWith('#') || articleValues(line).length > 0) break
    block.push(line)
  }
  return block
}

/** The line at `start` plus the lines under it, stopped by the next heading or the line cap. */
function collectSection(lines: string[], start: number): string[] {
  const head = lines[start]
  if (head === undefined) return []
  const block = [head]
  for (let at = start + 1; at < lines.length && block.length < MAX_BLOCK_LINES; at += 1) {
    const line = lines[at]
    if (line === undefined || line.startsWith('#')) break
    block.push(line)
  }
  while (block.length > 0 && (block.at(-1) ?? '').trim() === '') block.pop()
  return block
}

/**
 * Strip the markdown a wiki page carries into the plain text the card shows.
 * @param text - Markdown block.
 * @returns the same block without emphasis marks, link targets, or heading marks.
 */
function flattenMarkdown(text: string): string {
  return text
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_all, target: string, label?: string) =>
      label ?? (target.split('/').pop() ?? '').replace(/\.md$/, ''))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
