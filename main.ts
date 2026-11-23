// mend -- apply model-written edits to a tree of text files, all or nothing.
// Node 22, standard library only. See SPEC.md for the contract.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS: string[] = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

type Edit = (tree: Tree) => void;

const blank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const raw = text.split('\n');
  if (text.endsWith('\n')) raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

interface FFile {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text into lines, its own line break, and whether it ends with one. */
function toFile(text: string): FFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  if (nl < 0) return { lines: [text], br: '\n', final: false };
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function fromFile(f: FFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: `now` holds touched paths (null: gone), the rest on disk. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  before(p: string): string | null {
    if (this.disk.has(p)) return this.disk.get(p)!;
    let v: string | null = null;
    try {
      if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
    } catch {
      v = null;
    }
    this.disk.set(p, v);
    return v;
  }

  at(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.before(p);
  }

  put(p: string, text: string): void {
    this.now.set(p, text);
  }

  remove(p: string): void {
    this.now.set(p, null);
  }
}

// ---------------------------------------------------------------- line tiers

interface NLine {
  text: string;
  ctx?: number;
}

function sameLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function allAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!sameLine(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTier(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  if (o.length === 0) return null;
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const at = allAt(lines, o, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** Replace the k lines at `pos` with N, taking context lines from the file and re-indenting at tier 2. */
function splice(lines: string[], o: string[], n: NLine[], pos: number, tier: number): string[] {
  const fp = leadWs(pos < lines.length ? lines[pos]! : '');
  const op = leadWs(o.length > 0 ? o[0]! : '');
  const mid: string[] = [];
  for (const e of n) {
    if (e.ctx !== undefined) {
      mid.push(lines[pos + e.ctx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(op)) t = fp + t.slice(op.length);
    mid.push(t);
  }
  return [...lines.slice(0, pos), ...mid, ...lines.slice(pos + o.length)];
}

// ---------------------------------------------------------------- JSON edits

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.at(p) !== null) throw new Fail('exists', p);
      tree.put(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      const before = tree.at(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const un = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = un(before);
      const old = un(oldStr);
      let hits = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) hits += 1;
      if (hits === 0) throw new Fail('no-match', p);
      if (hits > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + un(newStr) + text.slice(at + old.length);
      tree.put(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      const before = tree.at(p);
      if (before === null) throw new Fail('missing', p);
      const f = toFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines = [...f.lines.slice(0, line), ...add, ...f.lines.slice(line)];
      tree.put(p, fromFile(f));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const linesOut: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      linesOut.push(e);
    }
    return linesOut;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (blank(l)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const e = jsonEdit(parsed);
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    linesOut.push(e);
  }
  return linesOut;
}

// ---------------------------------------------------------------- detection

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => stripTrail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- unified diffs

interface Hunk {
  a: number;
  body: string[];
}

/** Path from a `--- ` / `+++ ` line: after four characters, up to first tab, trimmed, prefixes removed. */
function diffPath(rest: string): string | null {
  const cut = rest.split('\t')[0]!;
  const t = cut.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

function readBody(lines: string[], from: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = from;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (!isBodyLine(l)) break;
    body.push(l);
    i += 1;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

interface HunkPlan {
  oLines: string[];
  nLines: NLine[];
  a: number;
}

function planHunk(h: Hunk): HunkPlan {
  const oLines: string[] = [];
  const nLines: NLine[] = [];
  for (const l of h.body) {
    if (l.startsWith('\\')) continue;
    const text = l === '' ? '' : l.slice(1);
    if (l.startsWith('-')) {
      oLines.push(text);
    } else if (l.startsWith('+')) {
      nLines.push({ text });
    } else {
      nLines.push({ text, ctx: oLines.length });
      oLines.push(text);
    }
  }
  return { oLines, nLines, a: h.a };
}

/** Is there a `\` line after the last context or `+` line of this hunk's body? */
function backslashAfterLast(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    const l = h.body[i]!;
    if (l.startsWith(' ') || l.startsWith('+')) last = i;
  }
  if (last < 0) return false;
  for (let i = last + 1; i < h.body.length; i++) if (h.body[i]!.startsWith('\\')) return true;
  return false;
}

function applyHunks(start: FFile, hunks: Hunk[], strict: boolean, path: string): FFile {
  let lines = start.lines.slice();
  let final = start.final;
  let d = 0;
  for (const h of hunks) {
    const plan = planHunk(h);
    const o = plan.oLines;
    if (o.length === 0) {
      const pos = Math.max(0, Math.min(plan.a + d, lines.length));
      const atEnd = pos === lines.length;
      const mid: string[] = [];
      for (const e of plan.nLines) mid.push(e.text);
      lines = [...lines.slice(0, pos), ...mid, ...lines.slice(pos)];
      if (atEnd) final = !backslashAfterLast(h);
      d += plan.nLines.length;
      continue;
    }
    const found = firstTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = plan.a - 1 + d;
    let pos = found.at[0]!;
    let best = Math.abs(pos - target);
    for (const cand of found.at) {
      const dist = Math.abs(cand - target);
      if (dist < best) {
        best = dist;
        pos = cand;
      }
    }
    const end = pos + o.length;
    const atEnd = end === lines.length;
    lines = splice(lines, o, plan.nLines, pos, found.tier);
    if (atEnd) final = !backslashAfterLast(h);
    d += plan.nLines.length - o.length;
  }
  return { lines, br: start.br, final };
}

function createdText(hunks: Hunk[]): string {
  const flat: string[] = [];
  for (const h of hunks) for (const l of h.body) flat.push(l);
  const lines: string[] = [];
  for (const l of flat) if (l.startsWith('+')) lines.push(l.slice(1));
  let lastPlus = -1;
  for (let i = 0; i < flat.length; i++) if (flat[i]!.startsWith('+')) lastPlus = i;
  let suppress = false;
  if (lastPlus >= 0) {
    for (let i = lastPlus + 1; i < flat.length; i++) if (flat[i]!.startsWith('\\')) suppress = true;
  }
  if (lines.length === 0) return '';
  return fromFile({ lines, br: '\n', final: !suppress });
}

interface SectionRead {
  edit: Edit;
  next: number;
}

function readSection(lines: string[], start: number, fromDiff: boolean, diffOld: string | null, diffNew: string | null, strict: boolean): SectionRead {
  let i = start;
  let minus: string | null | undefined;
  let plus: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let newMode = false;
  let delMode = false;
  let sawPair = false;
  const hunks: Hunk[] = [];

  if (fromDiff) {
    i = start + 1;
  } else {
    minus = diffPath(lines[i]!.slice(4));
    plus = diffPath(lines[i + 1]!.slice(4));
    sawPair = true;
    i += 2;
  }

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const b = readBody(lines, i + 1);
      hunks.push({ a: Number(m[1]), body: b.body });
      i = b.next;
      continue;
    }
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sawPair || hunks.length > 0) break;
        minus = diffPath(l.slice(4));
        plus = diffPath(lines[i + 1]!.slice(4));
        sawPair = true;
        i += 2;
        continue;
      }
      if (hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      renameFrom = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renameTo = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      newMode = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      delMode = true;
      i += 1;
      continue;
    }
    i += 1;
  }

  const oldP: string | null | undefined = minus !== undefined ? minus : renameFrom !== undefined ? renameFrom : diffOld;
  const newP: string | null | undefined = plus !== undefined ? plus : renameTo !== undefined ? renameTo : diffNew;
  const oldPath = oldP === undefined ? null : oldP;
  const newPath = newP === undefined ? null : newP;

  const isCreate = oldPath === null || newMode;
  const isDelete = !isCreate && (newPath === null || delMode);

  const edit: Edit = (tree) => {
    const named: string[] = [];
    if (oldPath !== null) named.push(oldPath);
    if (newPath !== null && newPath !== oldPath) named.push(newPath);
    for (const p of named) if (!isSafe(p)) throw new Fail('unsafe', p);

    if (isCreate) {
      const target = newPath ?? oldPath;
      if (target === null) throw new Fail('exists', '');
      if (tree.at(target) !== null) throw new Fail('exists', target);
      tree.put(target, createdText(hunks));
      return;
    }
    if (isDelete) {
      const target = oldPath ?? newPath;
      if (target === null) throw new Fail('missing', '');
      if (tree.at(target) === null) throw new Fail('missing', target);
      tree.remove(target);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      if (tree.at(oldPath) === null) throw new Fail('missing', oldPath);
      if (tree.at(newPath) !== null) throw new Fail('exists', newPath);
      const src = toFile(tree.at(oldPath)!);
      const out = applyHunks(src, hunks, strict, oldPath);
      tree.put(newPath, fromFile(out));
      tree.remove(oldPath);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const target = oldPath ?? newPath!;
    if (tree.at(target) === null) throw new Fail('missing', target);
    const out = applyHunks(toFile(tree.at(target)!), hunks, strict, target);
    tree.put(target, fromFile(out));
  };

  return { edit, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = readSection(lines, i, true, m[1]!, m[2]!, strict);
      edits.push(r.edit);
      i = r.next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const r = readSection(lines, i, false, null, null, strict);
      edits.push(r.edit);
      i = r.next;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return edits;
}

// ---------------------------------------------------------------- SEARCH/REPLACE

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let i = 0;
  let lastPath: string | null = null;
  let afterPrevEnd = 0;

  while (i < lines.length) {
    if (stripTrail(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= afterPrevEnd; j--) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      const trimmed = cand.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);

    const oldLines: string[] = [];
    let k = searchLine + 1;
    let sawSep = false;
    let sawEnd = false;
    while (k < lines.length) {
      const l = stripTrail(lines[k]!);
      if (l === '=======') {
        sawSep = true;
        k += 1;
        break;
      }
      if (l === '>>>>>>> REPLACE') {
        sawEnd = true;
        break;
      }
      oldLines.push(lines[k]!);
      k += 1;
    }
    if (!sawSep) {
      if (sawEnd) throw new Exit2(`error: parse ${searchLine + 1}`);
      throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    const newLines: string[] = [];
    while (k < lines.length) {
      const l = stripTrail(lines[k]!);
      if (l === '>>>>>>> REPLACE') {
        sawEnd = true;
        break;
      }
      newLines.push(lines[k]!);
      k += 1;
    }
    if (!sawEnd) throw new Exit2(`error: parse ${searchLine + 1}`);

    blocks.push({ path, oldLines, newLines });
    lastPath = path;
    afterPrevEnd = k + 1;
    i = k + 1;
  }

  return blocks.map((b): Edit => {
    return (tree) => {
      if (!isSafe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.at(b.path) !== null) throw new Fail('exists', b.path);
        tree.put(b.path, fromFile({ lines: b.newLines, br: '\n', final: true }));
        return;
      }
      const cur = tree.at(b.path);
      if (cur === null) throw new Fail('missing', b.path);
      const f = toFile(cur);
      const found = firstTier(f.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.at.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.at[0]!;
      const n = b.newLines.map((t) => ({ text: t }));
      f.lines = splice(f.lines, b.oldLines, n, pos, found.tier);
      tree.put(b.path, fromFile(f));
    };
  });
}

// ---------------------------------------------------------------- V4A patches

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  target?: string;
  addLines: string[];
  chunks: Chunk[];
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}


function parseChunks(lines: string[], from: number): { chunks: Chunk[]; next: number } {
  const raw: string[][] = [];
  const anchors: Array<string | null> = [];
  const eofs: boolean[] = [];
  let i = from;

  const pushStart = (anchor: string | null, eof: boolean): void => {
    raw.push([]);
    anchors.push(anchor);
    eofs.push(eof);
  };

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('*** End of File')) {
      if (raw.length === 0) pushStart(null, true);
      else eofs[eofs.length - 1] = true;
      i += 1;
      continue;
    }
    if (l.startsWith('*** ')) break;
    if (l.startsWith('@@')) {
      pushStart(stripBoth(l.slice(2)), false);
      i += 1;
      continue;
    }
    if (!isBodyLine(l)) throw new Exit2(`error: parse ${i + 1}`);
    if (raw.length === 0) pushStart(null, false);
    raw[raw.length - 1]!.push(l);
    i += 1;
  }

  const chunks: Chunk[] = [];
  if (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    while (last.length > 0 && blank(last[last.length - 1]!)) last.pop();
  }
  for (let c = 0; c < raw.length; c++) {
    const body = raw[c]!;
    const o: string[] = [];
    const n: NLine[] = [];
    for (const l of body) {
      const text = l === '' ? '' : l.slice(1);
      if (l.startsWith('-')) {
        o.push(text);
      } else if (l.startsWith('+')) {
        n.push({ text });
      } else {
        n.push({ text, ctx: o.length });
        o.push(text);
      }
    }
    chunks.push({ anchor: anchors[c]!, eof: eofs[c]!, o, n });
  }
  return { chunks, next: i };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0) throw new Exit2('error: parse 1');
  if (lines[firstNonBlank]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNonBlank + 1}`);

  let lastNonBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { lastNonBlank = i; break; }
  }
  if (lastNonBlank < 0 || lines[lastNonBlank]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = firstNonBlank + 1;
  while (i < lastNonBlank) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) { kind = 'add'; path = stripBoth(l.slice('*** Add File: '.length)); }
    else if (l.startsWith('*** Delete File: ')) { kind = 'delete'; path = stripBoth(l.slice('*** Delete File: '.length)); }
    else if (l.startsWith('*** Update File: ')) { kind = 'update'; path = stripBoth(l.slice('*** Update File: '.length)); }
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);

    const sectionLine = i;
    i += 1;
    if (kind === 'add') {
      const addLines: string[] = [];
      while (i < lastNonBlank) {
        const b = lines[i]!;
        if (b.startsWith('*** ')) break;
        if (b.startsWith('+')) addLines.push(b.slice(1));
        else if (b === '') addLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (addLines.length > 0 && blank(addLines[addLines.length - 1]!)) addLines.pop();
      sections.push({ kind, path, line: sectionLine, addLines, chunks: [] });
      continue;
    }
    if (kind === 'delete') {
      sections.push({ kind, path, line: sectionLine, addLines: [], chunks: [] });
      continue;
    }

    let target: string | undefined;
    if (i < lastNonBlank && lines[i]!.startsWith('*** Move to: ')) {
      target = stripBoth(lines[i]!.slice('*** Move to: '.length));
      i += 1;
    }
    const parsed = parseChunks(lines, i);
    i = parsed.next;
    if (target === undefined && parsed.chunks.length === 0) throw new Exit2(`error: parse ${sectionLine + 1}`);
    sections.push({ kind, path, line: sectionLine, target, addLines: [], chunks: parsed.chunks });
  }

  return sections.map((s): Edit => {
    return (tree) => {
      const named = [s.path];
      if (s.target !== undefined) named.push(s.target);
      for (const p of named) if (!isSafe(p)) throw new Fail('unsafe', p);

      if (s.kind === 'add') {
        if (tree.at(s.path) !== null) throw new Fail('exists', s.path);
        tree.put(s.path, fromFile({ lines: s.addLines, br: '\n', final: true }));
        return;
      }
      if (s.kind === 'delete') {
        if (tree.at(s.path) === null) throw new Fail('missing', s.path);
        tree.remove(s.path);
        return;
      }

      const src = tree.at(s.path);
      if (src === null) throw new Fail('missing', s.path);
      if (s.target !== undefined && tree.at(s.target) !== null) throw new Fail('exists', s.target);

      const f = toFile(src);
      let linesOut = f.lines.slice();
      let final = f.final;
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          let hit = -1;
          const top = strict ? 0 : 2;
          outer: for (let tier = 0; tier <= top; tier++) {
            for (let k = cursor; k < linesOut.length; k++) {
              if (sameLine(linesOut[k]!, ch.anchor, tier)) { hit = k; break outer; }
            }
          }
          if (hit < 0) throw new Fail('no-match', s.path);
          cursor = hit + 1;
        }
        if (ch.o.length === 0) {
          if (ch.eof) {
            linesOut = [...linesOut, ...ch.n.map((e) => e.text)];
            cursor = linesOut.length;
            final = final;
          } else {
            const ins = ch.n.map((e) => e.text);
            linesOut = [...linesOut.slice(0, cursor), ...ins, ...linesOut.slice(cursor)];
            cursor += ins.length;
          }
        } else {
          let pos = -1;
          let tier = 0;
          const top = strict ? 0 : 2;
          outer2: for (let t = 0; t <= top; t++) {
            for (let k = cursor; k + ch.o.length <= linesOut.length; k++) {
              if (ch.eof && k + ch.o.length !== linesOut.length) continue;
              let ok = true;
              for (let j = 0; j < ch.o.length; j++) {
                if (!sameLine(linesOut[k + j]!, ch.o[j]!, t)) { ok = false; break; }
              }
              if (ok) { pos = k; tier = t; break outer2; }
            }
          }
          if (pos < 0) throw new Fail('no-match', s.path);
          linesOut = splice(linesOut, ch.o, ch.n, pos, tier);
          cursor = pos + ch.n.length;
        }
      }
      const out: FFile = { lines: linesOut, br: f.br, final };
      const text = fromFile(out);
      if (s.target !== undefined) {
        tree.put(s.target, text);
        tree.remove(s.path);
        tree.moves.push([s.path, s.target]);
      } else {
        tree.put(s.path, text);
      }
    };
  });
}

// ---------------------------------------------------------------- command line

function usage(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let sawFormat = false;
  let sawCheck = false;
  let sawStrict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (sawFormat || !FORMATS.includes(v)) return usage();
        sawFormat = true;
        format = v;
        continue;
      }
      if (a === '--check') {
        if (sawCheck) return usage();
        sawCheck = true;
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (sawStrict) return usage();
        sawStrict = true;
        strict = true;
        continue;
      }
      return usage();
    }
    pos.push(a);
  }
  if (pos.length > 1) return usage();

  const arg = pos.length === 0 ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(arg === null || arg === '-' ? 0 : arg, 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const keepNow = new Map(tree.now);
    const keepMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of keepNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...keepMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  const moves: Array<[string, string]> = [];
  for (const [o, n] of tree.moves) {
    if (tree.before(o) !== null && tree.at(o) === null && tree.before(n) === null && tree.at(n) !== null) moves.push([o, n]);
  }
  const inMove = new Set<string>();
  for (const [o, n] of moves) {
    inMove.add(o);
    inMove.add(n);
  }

  const rows: Array<{ key: string; text: string }> = [];
  const changed: string[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.before(p);
    const now = tree.at(p);
    if (was === now) continue;
    changed.push(p);
    if (inMove.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of moves) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((a, b) => byBytes(a.key, b.key));

  if (!check) {
    for (const p of changed) {
      const now = tree.at(p);
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  const out = rows.map((r) => r.text);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
