/**
 * Rich-text notes (Notes tab + CRM lead notes).
 *
 * A note keeps its plain-text `body` — search, list previews, the Overview feed and Asuka
 * (via /api/sync) all read that — and, when it carries formatting, an `html` copy made by the
 * editor. The html is untrusted on the way in (anything holding the sync token can write it),
 * so it only ever reaches the page through `cleanNoteHtml`, an allowlist that keeps:
 *   b · i · u · s · br · div · ul/ol/li, and spans whose style is limited to
 *   color, background-color (highlight), font-size keywords, font-weight/-style, text-decoration.
 * Everything else is dropped (script, style, iframe, img…) or unwrapped to its text (a, h1, table…).
 *
 * If `body` is changed somewhere that doesn't know about `html` (Asuka rewriting a note), the
 * two stop matching and the board falls back to the plain body instead of showing stale text.
 *
 * Browser-only: everything here parses with DOMParser. Without it (server render) the helpers
 * return null / plain text, so callers just show `body`.
 */

/** Ink colours readable on white — the board's own section hues. */
export const TEXT_COLORS: { label: string; value: string }[] = [
  { label: "Default", value: "#3a2a36" },
  { label: "Gray", value: "#665e6c" },
  { label: "Red", value: "#b44044" },
  { label: "Pink", value: "#b03c74" },
  { label: "Orange", value: "#ac4a1e" },
  { label: "Amber", value: "#9a5702" },
  { label: "Green", value: "#00783b" },
  { label: "Teal", value: "#09746e" },
  { label: "Blue", value: "#1968bc" },
  { label: "Purple", value: "#8251b0" },
];

/** Highlighter pastels — plum ink stays ≥ 9:1 on every one. */
export const HIGHLIGHTS: { label: string; value: string }[] = [
  { label: "None", value: "transparent" },
  { label: "Yellow", value: "#fff0a0" },
  { label: "Pink", value: "#f8cee0" },
  { label: "Orange", value: "#ffd8bd" },
  { label: "Green", value: "#c8eed5" },
  { label: "Blue", value: "#cfe3fa" },
  { label: "Purple", value: "#e4d7f5" },
  { label: "Gray", value: "#e8e3e7" },
];

/** execCommand("fontSize") steps → the CSS keyword the browser writes for them. */
export const TEXT_SIZES: { label: string; step: string; css: string }[] = [
  { label: "Small", step: "2", css: "small" },
  { label: "Normal", step: "3", css: "medium" },
  { label: "Large", step: "5", css: "x-large" },
  { label: "Huge", step: "6", css: "xx-large" },
];

export interface RichValue {
  /** Plain text — what goes in `body`. */
  text: string;
  /** Clean html, or undefined when nothing is formatted (the note stays plain). */
  html?: string;
}

const DROP = new Set([
  "SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "CANVAS",
  "VIDEO", "AUDIO", "IMG", "PICTURE", "SOURCE", "INPUT", "TEXTAREA", "SELECT", "BUTTON",
  "HEAD", "TITLE", "META", "LINK", "NOSCRIPT", "FORM",
]);
/** Kept tags, after renaming (strong → b, …). */
const RENAME: Record<string, string> = {
  B: "b", STRONG: "b",
  I: "i", EM: "i",
  U: "u", INS: "u",
  S: "s", STRIKE: "s", DEL: "s",
  SPAN: "span", FONT: "span",
  BR: "br",
  DIV: "div", P: "div", BLOCKQUOTE: "div", H1: "div", H2: "div", H3: "div", H4: "div", H5: "div", H6: "div", PRE: "div",
  UL: "ul", OL: "ol", LI: "li",
};
const BLOCKS = new Set(["div", "ul", "ol", "li"]);
const SIZE_KEYWORDS = new Set(["x-small", "small", "large", "x-large", "xx-large", "xxx-large", "-webkit-xxx-large"]);
/** <font size="n"> → keyword, for browsers that still write the old tag. */
const FONT_SIZE_ATTR: Record<string, string> = { "1": "x-small", "2": "small", "4": "large", "5": "x-large", "6": "xx-large", "7": "xxx-large" };
const INK = "rgb(58, 42, 54)";

function hasDom(): boolean {
  return typeof DOMParser !== "undefined";
}

function parse(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html").body;
}

function rgbOf(color: string): [number, number, number] | null {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(color);
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; // fully transparent
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Only plain colour values make it through; anything that could carry url()/expression() can't. */
function safeColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(v) || /^rgba?\([\d\s.,%/]+\)$/.test(v) || /^[a-z]{3,20}$/.test(v)) return v;
  return null;
}

/** The style a kept element is allowed to carry, as a normalized "prop: value; …" string. */
function keptStyle(el: HTMLElement, paste: boolean): string {
  const out: string[] = [];
  const s = el.style;

  let color = s.getPropertyValue("color");
  if (el.tagName === "FONT" && !color) color = el.getAttribute("color") || "";
  const c = color && safeColor(color);
  if (c && !["inherit", "initial", "unset", "currentcolor", "transparent"].includes(c)) {
    const rgb = rgbOf(c);
    // default ink is "no colour"; clear text, or near-white text pasted from a dark page, would be invisible here
    const invisible = (c.startsWith("rgb") && !rgb) || (paste && rgb && rgb.every((x) => x > 225));
    // pasted black (most documents' default) reads as the board's own ink, not a colour choice
    const plain = paste && ((rgb && rgb.every((x) => x < 50)) || c === "black");
    if (c !== INK && c !== "#3a2a36" && !invisible && !plain) out.push(`color: ${c}`);
  }

  const bg = s.getPropertyValue("background-color");
  const b = bg && safeColor(bg);
  if (b && !["inherit", "initial", "unset", "transparent", "none"].includes(b)) {
    const rgb = rgbOf(b);
    const blank = (b.startsWith("rgb") && !rgb) || (rgb && rgb.every((x) => x > 250)) || b === "white" || b === "#fff" || b === "#ffffff";
    if (!blank) out.push(`background-color: ${b}`);
  }

  let size = s.getPropertyValue("font-size").trim().toLowerCase();
  if (el.tagName === "FONT" && !size) size = FONT_SIZE_ATTR[el.getAttribute("size") || ""] || "";
  if (SIZE_KEYWORDS.has(size)) out.push(`font-size: ${size === "-webkit-xxx-large" ? "xxx-large" : size}`);

  const weight = s.getPropertyValue("font-weight").trim();
  if (weight === "bold" || weight === "bolder" || /^[6-9]00$/.test(weight)) out.push("font-weight: bold");
  else if (!paste && (weight === "normal" || weight === "400")) out.push("font-weight: normal");

  const fstyle = s.getPropertyValue("font-style").trim();
  if (fstyle === "italic") out.push("font-style: italic");
  else if (!paste && fstyle === "normal") out.push("font-style: normal");

  const deco = (s.getPropertyValue("text-decoration-line") || s.getPropertyValue("text-decoration")).toLowerCase();
  const lines = ["underline", "line-through"].filter((d) => deco.includes(d));
  if (lines.length) out.push(`text-decoration: ${lines.join(" ")}`);
  else if (!paste && deco.includes("none")) out.push("text-decoration: none");

  return out.join("; ");
}

const isBlockEl = (n: Node | null) => !!n && n.nodeType === 1 && BLOCKS.has(RENAME[(n as Element).tagName] || "");

function cleanChildren(from: Node, to: Node, doc: Document, paste: boolean) {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === 3) {
      let text = child.nodeValue || "";
      if (paste) {
        // pasted html uses normal white-space rules; the note renders pre-wrap, so collapse it here
        text = text.replace(/[\t\n\r ]+/g, " ");
        const inBlock = from.nodeName === "BODY" || isBlockEl(from);
        const prev = child.previousSibling;
        const next = child.nextSibling;
        if (!text.trim() && inBlock && (!prev || !next || isBlockEl(prev) || isBlockEl(next))) continue;
      }
      if (text) to.appendChild(doc.createTextNode(text));
      continue;
    }
    if (child.nodeType !== 1) continue; // comments, processing instructions
    const el = child as HTMLElement;
    if (DROP.has(el.tagName)) continue;
    let tag = RENAME[el.tagName];
    // a <b> styled back to normal weight isn't bold — Google Docs wraps every copy in one
    const w = el.style.getPropertyValue("font-weight").trim();
    if (tag === "b" && (w === "normal" || /^[1-5]00$/.test(w))) tag = "span";
    if (tag === "i" && el.style.getPropertyValue("font-style").trim() === "normal") tag = "span";
    if (!tag) {
      cleanChildren(el, to, doc, paste); // unknown wrapper (a, table, section…): keep its text
      if (/^(TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|NAV|MAIN|FIGURE|DL|DT|DD)$/.test(el.tagName)) {
        to.appendChild(doc.createElement("br"));
      }
      continue;
    }
    if (tag === "br") {
      to.appendChild(doc.createElement("br"));
      continue;
    }
    const style = keptStyle(el, paste);
    if (tag === "span" && !style) {
      cleanChildren(el, to, doc, paste);
      continue;
    }
    const out = doc.createElement(tag);
    // blocks stay bare (so "only <div>/<br>" means unformatted); their styling moves onto an inner span
    let inner: HTMLElement = out;
    if (style && BLOCKS.has(tag)) {
      inner = doc.createElement("span");
      inner.setAttribute("style", style);
      out.appendChild(inner);
    } else if (style) {
      out.setAttribute("style", style);
    }
    cleanChildren(el, inner, doc, paste);
    if (inner !== out && !inner.firstChild) out.removeChild(inner);
    // an emptied inline wrapper adds nothing; empty blocks are kept (they're blank lines)
    if (!BLOCKS.has(tag) && !out.firstChild) continue;
    to.appendChild(out);
  }
}

/** Sanitize html for storage or display. Returns "" when there's no DOM to parse with. */
export function cleanNoteHtml(html: string, opts: { paste?: boolean } = {}): string {
  if (!hasDom() || !html) return "";
  const src = parse(html);
  const doc = src.ownerDocument;
  const out = doc.createElement("div");
  cleanChildren(src, out, doc, !!opts.paste);
  return out.innerHTML;
}

/**
 * Plain text of clean html, laid out the way it reads: one line per block / <br>,
 * "• " and "1. " in front of list items, non-breaking spaces turned back into spaces.
 */
export function richToPlain(html: string): string {
  if (!hasDom() || !html) return "";
  const parts: string[] = [];
  const atLineStart = () => !parts.length || parts[parts.length - 1].endsWith("\n");
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        parts.push((child.nodeValue || "").replace(/ /g, " "));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as HTMLElement;
      const tag = el.tagName;
      if (tag === "BR") {
        parts.push("\n");
        continue;
      }
      const block = tag === "DIV" || tag === "P" || tag === "UL" || tag === "OL" || tag === "LI";
      if (block && !atLineStart()) parts.push("\n");
      if (tag === "LI") {
        const list = el.parentElement;
        if (list?.tagName === "OL") {
          const n = Array.from(list.children).filter((c) => c.tagName === "LI").indexOf(el) + 1;
          parts.push(`${n}. `);
        } else {
          parts.push("• ");
        }
      }
      walk(el);
      if (block && !atLineStart()) parts.push("\n");
    }
  };
  walk(parse(html));
  return parts.join("").replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
}

/** True when clean html carries anything beyond line breaks. */
export function hasFormatting(clean: string): boolean {
  return /<(?!\/?(?:div|br)\b)[a-z]/i.test(clean);
}

/** Editor html → what a note stores. */
export function richFromEditor(html: string): RichValue {
  const clean = cleanNoteHtml(html);
  const text = richToPlain(clean);
  return hasFormatting(clean) ? { text, html: clean } : { text };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The html to show for a note, or null to show the plain body — no html, no DOM yet, or the
 * html no longer matches a body that was changed elsewhere.
 */
export function noteHtml(body: string, html: unknown): string | null {
  if (typeof html !== "string" || !html || !hasDom()) return null;
  const clean = cleanNoteHtml(html);
  if (!clean || squash(richToPlain(clean)) !== squash(body)) return null;
  return clean;
}

/** Plain text as editor html (each line its own row). */
export function plainToRich(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.split("\n").map(esc).join("<br>");
}

/** What the editor should open with for an existing note. */
export function editorHtml(body: string, html: unknown): string {
  return noteHtml(body, html) ?? plainToRich(body);
}
