// solve.js — a fast, dependency-free reimplementation of makefun-site 1.0.0's
// build semantics (see the competition kit's baseline/makefun-site for the
// reference program). run(input) returns exactly the output tree the reference
// build returns for the same input: every output path and its text, byte for
// byte. Pure JavaScript, no WASM, no native addon, no network, no clock, no
// unseeded randomness: the output is a function of the input alone.
//
// Speed comes from removing the reference's per-character work: the inline
// Markdown renderer scans for markup in bulk and never escapes a run of plain
// text (it holds no escapable character by construction), the block lexer and
// renderer run in one fused pass with no token objects, template rendering
// accumulates into one array over a frame stack instead of string-concatenating
// through scope objects, and the word counter counts without allocating.

// ---------------------------------------------------------------- text

/** The HTML escape table, in the reference's order. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. A single test first: most strings hold no escapable character and skip the replace. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Combining marks, for the non-ASCII slug path (the reference's rule). */
const MARKS_RE = /\p{M}/gu;

/**
 * The slug of `text`, the reference's rule: NFKD, combining marks dropped, A-Z
 * lowered, every run of characters other than a-z and 0-9 one "-", none at
 * either end, at most 64 characters (a "-" left at the cut dropped), and
 * "untitled" when nothing is left. ASCII input takes a fast path: NFKD and the
 * mark strip are identities on ASCII, so the loop below is exactly equivalent.
 */
function slugify(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return slugifyWide(text);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  return finishSlug(out);
}

/** The reference's slug rule for text holding a non-ASCII character. */
function slugifyWide(text) {
  const plain = text.normalize('NFKD').replace(MARKS_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return finishSlug(out);
}

/** A slug cut to 64 characters with a "-" left at the cut dropped, or "untitled". */
function finishSlug(out) {
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether a code unit is JavaScript whitespace (the \s class). */
function isSpace(c) {
  return (
    c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a YYYY-MM-DD date from 1970-01-01 to 2099-12-31. */
function isDate(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
  const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
  const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** Whether `raw` is a template name (a-z, 0-9 and "-"). */
function isName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug (a-z and 0-9, single "-" between), at most 64 characters. */
function isSlug(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDate(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether a line is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The closing "---" is found by
 * a direct search instead of splitting the whole body: the front matter is a
 * handful of lines and the body can be kilobytes.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeOff = text.indexOf('\n---\n', 3);
  let bodyOff;
  if (closeOff !== -1) bodyOff = closeOff + 5;
  else if (text.endsWith('\n---')) {
    closeOff = text.length - 4;
    bodyOff = text.length;
  } else return { error: 'the front matter is not closed' };
  const data = {};
  const fm = text.slice(4, closeOff);
  if (fm !== '') {
    const lines = fm.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (isBlank(line) || line.charCodeAt(0) === 35) continue;
      // The reference's LINE rule: a key of a-z and "_", a colon, then either
      // the end of the line or one space and the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${j + 2} is not "key: value"` };
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c !== 32 && c !== 9) break;
        e--;
      }
      if (e !== raw.length) raw = raw.slice(0, e);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyOff) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, by code unit. */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** The characters the inline scanner stops at: markup openers and escapables. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/** The first index from `from` (under `end`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wl = what.length;
  const last = end - wl;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (under `end`: one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` from `lo` to `hi` rendered inline, appended to `out`. `link(target)` is
 * a link's href. Plain runs between markup characters are appended as they
 * stand: they hold no escapable character by construction, so no per-character
 * escaping ever runs.
 */
function inline(s, lo, hi, link, out) {
  let i = lo;
  while (i < hi) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const at = m === null || m.index >= hi ? -1 : m.index;
    if (at === -1) {
      out.push(s.slice(i, hi));
      return;
    }
    if (at > i) out.push(s.slice(i, at));
    const c = s.charCodeAt(at);
    if (c === 38) { out.push('&amp;'); i = at + 1; continue; }
    if (c === 60) { out.push('&lt;'); i = at + 1; continue; }
    if (c === 62) { out.push('&gt;'); i = at + 1; continue; }
    if (c === 34) { out.push('&quot;'); i = at + 1; continue; }
    if (c === 39) { out.push('&#39;'); i = at + 1; continue; }
    if (c === 92) {
      if (at + 1 < hi && s.charCodeAt(at + 1) < 128 && ESCAPABLE[s.charCodeAt(at + 1)]) {
        const n = s.charCodeAt(at + 1);
        out.push(n === 62 ? '&gt;' : s[at + 1]);
        i = at + 2;
      } else {
        out.push('\\');
        i = at + 1;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', at + 1);
      if (j !== -1 && j < hi && j > at + 1) {
        out.push('<code>', esc(s.slice(at + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i = at + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(at + 1) === 42) {
        const j = findUnescaped(s, '**', at + 2, hi);
        if (j > at + 2) {
          out.push('<strong>');
          inline(s, at + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i = at + 2;
        }
        continue;
      }
      const j = findSingleStar(s, at + 1, hi);
      if (j > at + 1) {
        out.push('<em>');
        inline(s, at + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i = at + 1;
      }
      continue;
    }
    // c === 91, '[': a link when the first unescaped ']' is followed at once
    // by '(' and the next ')' closes a target that is not empty and holds no
    // whitespace; else '[' is itself.
    const k = findUnescaped(s, ']', at + 1, hi);
    let m2 = -1;
    if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
      m2 = s.indexOf(')', k + 2);
      if (m2 >= hi) m2 = -1;
    }
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="', esc(link(target)), '">');
      inline(s, at + 1, k, link, out);
      out.push('</a>');
      i = m2 + 1;
    } else {
      out.push('[');
      i = at + 1;
    }
  }
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` from `from` holds only spaces and tabs. */
function restBlank(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` is not a fence opener. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  if (!restBlank(line, i)) return null;
  return line.slice(3, i);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && restBlank(line, 3);
}

/** A heading's [level, text], or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6 || k >= line.length) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let a = k;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return [k, line.slice(a, b)];
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  return line.charCodeAt(1) === c && line.charCodeAt(2) === c && restBlank(line, 3);
}

/** An ordered list's [start, text], or null. */
function orderedOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
  if (k === 0 || k > 9) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return [Number(line.slice(0, k)), line.slice(k + 2)];
}

/** Whether `line` continues a list item: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isSpace(line.charCodeAt(k));
}

/**
 * A list starting at `lines[i]` (`ordered` for a numbered list): its HTML and
 * the index after its last line. A list item is a marker line, and a line that
 * continues it (two or more spaces, then a non-whitespace character) joins the
 * item before it; anything else ends the list.
 */
function listBlock(lines, i, ordered, link) {
  const items = [];
  let start = 1;
  let first = true;
  while (i < lines.length) {
    const l = lines[i];
    if (ordered) {
      const o = orderedOf(l);
      if (o !== null) {
        if (first) {
          start = o[0];
          first = false;
        }
        items.push([trimLine(o[1])]);
        i++;
        continue;
      }
    } else if (l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) {
      if (l.charCodeAt(1) === 32) {
        items.push([trimLine(l.slice(2))]);
        i++;
        continue;
      }
    }
    if (isContinued(l)) {
      items[items.length - 1].push(trimLine(l));
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const parts = [ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n'];
  for (const item of items) {
    const text = item.join('\n');
    parts.push('<li>');
    inline(text, 0, text.length, link, parts);
    parts.push('</li>\n');
  }
  parts.push(`</${tag}>`);
  return [parts.join(''), i];
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML), its
 * excerpt (the first paragraph's inline HTML, or "") and its word count (the
 * runs of non-whitespace, as the reference counts them). Lexing and rendering
 * run in one pass, with no token objects. The lines are split and the words
 * counted in the same scan: a newline is whitespace, so no word spans a line.
 */
function renderMarkdown(src, link) {
  const lines = [];
  let words = 0;
  let start = 0;
  let inWord = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      lines.push(src.slice(start, i));
      start = i + 1;
      inWord = false;
    } else if (c === 32 || (c >= 9 && c <= 13) || (c >= 127 && isSpace(c))) inWord = false;
    else if (!inWord) {
      words++;
      inWord = true;
    }
  }
  lines.push(src.slice(start));
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    // The block kind is read off the first character and each line is parsed
    // once: a fence's language, a heading's level and text, a list's marker.
    const c = line.charCodeAt(0);
    if (c === 32 || c === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        blocks.push(`<pre><code${lang === '' ? '>' : ` class="language-${lang}">`}${body.length === 0 ? '' : esc(body.join('\n') + '\n')}</code></pre>`, '\n');
        continue;
      }
    } else if (c === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h[1]), ids);
        const parts = [];
        inline(h[1], 0, h[1].length, link, parts);
        const html = parts.join('');
        blocks.push(`<h${h[0]} id="${id}">${html}</h${h[0]}>`, '\n');
        if (h[0] === 2 || h[0] === 3) toc.push({ level: h[0], id, html });
        i++;
        continue;
      }
    } else if (c === 45 || c === 42) {
      if (isHr(line)) {
        blocks.push('<hr>', '\n');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        const [html, next] = listBlock(lines, i, false, link);
        blocks.push(html, '\n');
        i = next;
        continue;
      }
    } else if (c === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>', '\n');
      else {
        const joined = kept.join('\n');
        const parts = ['<blockquote>\n<p>'];
        inline(joined, 0, joined.length, link, parts);
        parts.push('</p>\n</blockquote>');
        blocks.push(parts.join(''), '\n');
      }
      continue;
    } else if (c >= 48 && c <= 57) {
      if (orderedOf(line) !== null) {
        const [html, next] = listBlock(lines, i, true, link);
        blocks.push(html, '\n');
        i = next;
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length) {
      // A paragraph ends at a blank line, a fence, a heading or a thematic
      // break; anything else (a quote, a list line) is paragraph text.
      const l = lines[i];
      if (l.length === 0) break;
      const c = l.charCodeAt(0);
      if (c === 32 || c === 9) {
        if (isBlank(l)) break;
      } else if (c === 96) {
        if (fenceLang(l) !== null) break;
      } else if (c === 35) {
        if (headingOf(l) !== null) break;
      } else if (c === 45 || c === 42) {
        if (isHr(l)) break;
      }
      body.push(trimLine(l));
      i++;
    }
    const text = body.join('\n');
    const parts = ['<p>'];
    inline(text, 0, text.length, link, parts);
    parts.push('</p>');
    const html = parts.join('');
    if (excerpt === null) excerpt = parts.slice(1, -1).join('');
    blocks.push(html, '\n');
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = restBlank(src.slice(lineStart, open), 0) && restBlank(src.slice(end, lineEnd), 0);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the frame stack: its first name from the nearest frame holding it, then own properties. */
function lookup(frames, path) {
  let v;
  let found = false;
  for (let f = frames.length - 1; f >= 0; f--) {
    if (Object.hasOwn(frames[f], path[0])) {
      v = frames[f][path[0]];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered over the frame stack, appended to `out`. `ctx` holds the
 * parsed templates (`templates`), each template's cache analysis (`info`), the
 * per-case cache of scope-independent renders (`cache`) and the case-global
 * frame (`root`). Rendering walks the tree with one output array and one frame
 * stack, so no intermediate strings or scope objects are made per node.
 *
 * A template whose every free variable is one of the case-globals (site, tags,
 * recent) renders the same for every page of the case, so its first render is
 * cached and later includes of it reuse the string. The cache is used only
 * where the include-depth limit cannot cut the two renders apart (see below).
 */
function renderNodes(nodes, frames, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var': {
        const v = lookup(frames, node.path);
        if (typeof v === 'string') out.push(esc(v));
        else if (typeof v === 'number') out.push(String(v));
        else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
        else if (Array.isArray(v)) out.push(esc(textOf(v)));
        break;
      }
      case 'raw':
        out.push(textOf(lookup(frames, node.path)));
        break;
      case 'if': {
        const branch = truthy(lookup(frames, node.path)) !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, frames, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(frames, node.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          frames.push({ [node.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } });
          renderNodes(node.body, frames, ctx, depth, out);
          frames.pop();
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const info = ctx.info.get(node.name);
        // The cached string renders the template as if included from depth 0
        // (at depth 1). A live include at depth d renders it at depth d+1; the
        // two agree exactly when no include in its subtree is cut off by the
        // depth limit in one and not the other, which is d + maxR < 8, where
        // maxR is the deepest include below it (its own includes at depth 1).
        if (info.cacheable && depth + info.maxR < INCLUDE_DEPTH) {
          let s = ctx.cache.get(node.name);
          if (s === undefined) {
            const tmp = [];
            renderNodes(t, [ctx.root], ctx, 1, tmp);
            s = tmp.join('');
            ctx.cache.set(node.name, s);
          }
          out.push(s);
        } else {
          renderNodes(t, frames, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

/**
 * Each template's cache analysis: its free variables (root names it may read,
 * through its own loops and its includes, with no name bound by an enclosing
 * loop) and the deepest include below it. A template is cacheable when its
 * include subgraph has no cycle, every free variable is a case-global, and no
 * loop anywhere binds a case-global name (which would let an enclosing loop
 * shadow the global it reads).
 */
function analyzeTemplates(templates) {
  const info = new Map();
  const visiting = new Set();
  const freeOf = (name, bound) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return new Set();
    if (visiting.has(name)) return null;
    visiting.add(name);
    const free = new Set();
    let failed = false;
    const walk = (ns, boundSet) => {
      for (const node of ns) {
        if (failed) return;
        if (node.kind === 'var' || node.kind === 'raw' || node.kind === 'if') {
          if (!boundSet.has(node.path[0])) free.add(node.path[0]);
          if (node.kind === 'if') {
            walk(node.then, boundSet);
            if (node.else !== null) walk(node.else, boundSet);
          }
        } else if (node.kind === 'for') {
          if (!boundSet.has(node.path[0])) free.add(node.path[0]);
          const inner = new Set(boundSet);
          inner.add(node.name);
          inner.add('loop');
          walk(node.body, inner);
        } else if (node.kind === 'include') {
          const sub = freeOf(node.name, boundSet);
          if (sub === null) {
            failed = true;
            return;
          }
          for (const v of sub) if (!boundSet.has(v)) free.add(v);
        }
      }
    };
    walk(nodes, bound);
    visiting.delete(name);
    return failed ? null : free;
  };
  const depthOf = (name) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return 0;
    if (visiting.has(name)) return null;
    visiting.add(name);
    let max = 0;
    let failed = false;
    const walk = (ns) => {
      for (const node of ns) {
        if (failed) return;
        if (node.kind === 'for') walk(node.body);
        else if (node.kind === 'if') {
          walk(node.then);
          if (node.else !== null) walk(node.else);
        } else if (node.kind === 'include') {
          const d = depthOf(node.name);
          if (d === null) {
            failed = true;
            return;
          }
          if (d + 1 > max) max = d + 1;
        }
      }
    };
    walk(nodes);
    visiting.delete(name);
    return failed ? null : max;
  };
  // Every loop-variable name in the case: one that names a case-global would
  // let a loop shadow it, so then nothing is cached.
  const loopVars = new Set();
  for (const nodes of templates.values()) {
    const walk = (ns) => {
      for (const node of ns) {
        if (node.kind === 'for') {
          loopVars.add(node.name);
          walk(node.body);
        } else if (node.kind === 'if') {
          walk(node.then);
          if (node.else !== null) walk(node.else);
        }
      }
    };
    walk(nodes);
  }
  const shadowRisk = loopVars.has('site') || loopVars.has('tags') || loopVars.has('recent');
  for (const name of templates.keys()) {
    const free = freeOf(name, new Set());
    const maxR = depthOf(name);
    const cacheable = !shadowRisk && free !== null && maxR !== null && [...free].every((v) => v === 'site' || v === 'tags' || v === 'recent');
    info.set(name, { cacheable, maxR: maxR === null ? 0 : maxR });
  }
  return info;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory whose parts are `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `t` opens with a URI scheme: a letter, then letters, digits, "+", "-" or ".", then ":". */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const linkCache = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const md = renderMarkdown(s.body, (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let path = null;
      if (rel !== '') {
        let byRel = linkCache.get(dir);
        if (byRel === undefined) {
          byRel = new Map();
          linkCache.set(dir, byRel);
        }
        if (byRel.has(rel)) path = byRel.get(rel);
        else {
          path = resolvePath(dirParts, rel);
          byRel.set(rel, path);
        }
      }
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const tags = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugify(tags[i]);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name: tags[i], slug });
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const tags = ownTags(p);
    for (let j = 0; j < tags.length; j++) {
      const { name, slug } = tags[j];
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = [];
  const recentN = input.site.recent;
  for (let i = 0; i < posts.length && i < recentN; i++) recent.push(cards.get(posts[i]));
  // One frame stack, reused by every render of this case (renders are never
  // re-entered): the case-global frame, then the render's own frame. A lookup
  // reads the render's frame first, exactly as the spread object did.
  const rootFrame = { site, tags: allTags, recent };
  const frames = [rootFrame, null];
  const ctx = { templates, info: analyzeTemplates(templates), cache: new Map(), root: rootFrame };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    frames[1] = vars;
    frames.length = 2;
    renderNodes(nodes, frames, ctx, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const pagePosts = [];
    const from = (k - 1) * per;
    const to = Math.min(k * per, posts.length);
    for (let i = from; i < to; i++) pagePosts.push(cards.get(posts[i]));
    const html = render('index', {
      posts: pagePosts,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const tagPosts = [];
    for (let j = 0; j < t.posts.length; j++) tagPosts.push(cards.get(t.posts[j]));
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tagPosts } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
