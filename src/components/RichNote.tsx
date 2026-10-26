"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { HIGHLIGHTS, TEXT_COLORS, TEXT_SIZES, cleanNoteHtml, noteHtml, richFromEditor, type RichValue } from "@/lib/rich-text";

/*
 * Rich-text note editor + viewer. The editor is a contentEditable box driven by the
 * browser's own editing commands (so Ctrl+Z undo, Ctrl+B/I/U, spellcheck and iOS text
 * selection all behave natively); whatever it produces goes through cleanNoteHtml before
 * it's stored or shown. See lib/rich-text.ts for the storage rules.
 */

type Cmd = "bold" | "italic" | "underline" | "strikeThrough" | "insertUnorderedList" | "insertOrderedList";
const STATE_CMDS: Cmd[] = ["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"];
type Menu = "color" | "highlight" | "size" | null;

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function RichTextEditor({
  initialHtml = "",
  onChange,
  onKeyDown,
  placeholder,
  ariaLabel,
  minHeight = 88,
  autoFocus,
}: {
  /** Read once on mount — remount (change `key`) to reset the editor. */
  initialHtml?: string;
  onChange?: (v: RichValue) => void;
  /** Gets every keydown the editor doesn't use itself (Ctrl+Enter to save, Esc to cancel…). */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  ariaLabel: string;
  minHeight?: number;
  autoFocus?: boolean;
}) {
  const area = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [active, setActive] = useState<Set<Cmd>>(() => new Set());
  const [empty, setEmpty] = useState(() => !richFromEditor(initialHtml).text && !/<li/i.test(initialHtml));
  const [menu, setMenu] = useState<Menu>(null);
  const [color, setColor] = useState(TEXT_COLORS[2].value);
  const [mark, setMark] = useState(HIGHLIGHTS[1].value);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.innerHTML = cleanNoteHtml(initialHtml);
    if (autoFocus) {
      el.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = document.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
    // initialHtml is deliberately read once; the parent remounts to reset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the caret: remember it (toolbar taps can steal focus on touch screens) and light up B/I/U/…
  useEffect(() => {
    function onSel() {
      const el = area.current;
      const s = document.getSelection();
      if (!el || !s || !s.rangeCount) return;
      const r = s.getRangeAt(0);
      if (!el.contains(r.commonAncestorContainer)) return;
      saved.current = r.cloneRange();
      const next = new Set<Cmd>();
      for (const c of STATE_CMDS) {
        try {
          if (document.queryCommandState(c)) next.add(c);
        } catch {
          /* unsupported command */
        }
      }
      setActive((prev) => (prev.size === next.size && [...next].every((c) => prev.has(c)) ? prev : next));
    }
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  // Keep an open menu inside the editor's box — on a phone the highlight menu would hang off the right edge.
  useLayoutEffect(() => {
    const el = pop.current;
    const box = bar.current;
    if (!el || !box) return;
    el.style.left = "0px";
    const over = el.getBoundingClientRect().right - box.getBoundingClientRect().right;
    if (over > 0) el.style.left = `${-over}px`;
  }, [menu]);

  // Close an open swatch menu on any press outside the toolbar.
  useEffect(() => {
    if (!menu) return;
    function onDown(e: PointerEvent) {
      if (!bar.current?.contains(e.target as Node)) setMenu(null);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  function emit() {
    const el = area.current;
    if (!el) return;
    const v = richFromEditor(el.innerHTML);
    setEmpty(!v.text && !el.querySelector("li"));
    onChange?.(v);
  }

  /** Put focus and the remembered selection back in the box before running a command. */
  function restore() {
    const el = area.current;
    if (!el) return;
    const s = document.getSelection();
    const inside = !!s && s.rangeCount > 0 && el.contains(s.getRangeAt(0).commonAncestorContainer);
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    if (!inside && saved.current && s) {
      s.removeAllRanges();
      s.addRange(saved.current);
    }
  }

  function exec(cmd: string, value?: string, css = false) {
    restore();
    document.execCommand("styleWithCSS", false, css ? "true" : "false");
    document.execCommand(cmd, false, value);
    if (css) document.execCommand("styleWithCSS", false, "false");
    emit();
    document.dispatchEvent(new Event("selectionchange"));
  }

  function applyColor(v: string) {
    setColor(v);
    setMenu(null);
    exec("foreColor", v, true);
  }
  function applyMark(v: string) {
    if (v !== "transparent") setMark(v);
    setMenu(null);
    exec("hiliteColor", v, true);
  }
  function applySize(step: string) {
    setMenu(null);
    exec("fontSize", step, true);
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    // keys the editor uses itself don't reach the parent's handlers (Esc there means "cancel the edit")
    const take = (run: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    if (mod && e.shiftKey && k === "h") return take(() => applyMark(mark));
    if (mod && e.shiftKey && k === "x") return take(() => exec("strikeThrough"));
    if (mod && k === "\\") return take(() => exec("removeFormat"));
    if (e.key === "Escape" && menu) return take(() => setMenu(null));
    if (e.key === "Tab" && !mod) {
      const s = document.getSelection();
      const node = s?.rangeCount ? s.getRangeAt(0).startContainer : null;
      const li = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest("li");
      if (li && area.current?.contains(li)) return take(() => exec(e.shiftKey ? "outdent" : "indent"));
    }
    onKeyDown?.(e);
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html && !text) return; // files etc. — nothing for a note to take
    e.preventDefault();
    const clean = html ? cleanNoteHtml(html, { paste: true }) : "";
    if (clean) document.execCommand("insertHTML", false, clean);
    else document.execCommand("insertText", false, text);
    emit();
  }

  return (
    <div className="rte">
      <div className="rte-toolbar" role="toolbar" aria-label={`${ariaLabel} formatting`} ref={bar}>
        <ToolBtn pressed={active.has("bold")} onPress={() => exec("bold")} label="Bold" keys={`${MOD}B`}><b style={{ fontSize: 15 }}>B</b></ToolBtn>
        <ToolBtn pressed={active.has("italic")} onPress={() => exec("italic")} label="Italic" keys={`${MOD}I`}><i style={{ fontSize: 15, fontFamily: "Georgia, serif" }}>I</i></ToolBtn>
        <ToolBtn pressed={active.has("underline")} onPress={() => exec("underline")} label="Underline" keys={`${MOD}U`}><u style={{ fontSize: 15, textUnderlineOffset: 2 }}>U</u></ToolBtn>
        <ToolBtn pressed={active.has("strikeThrough")} onPress={() => exec("strikeThrough")} label="Strikethrough" keys={`${MOD}Shift+X`}><s style={{ fontSize: 15 }}>S</s></ToolBtn>
        <span className="rte-sep" aria-hidden />

        <span className="rte-split">
          <ToolBtn label="Text color" onPress={() => applyColor(color)}>
            <span className="rte-glyph">
              <span style={{ fontWeight: 600, fontSize: 15, lineHeight: 1 }}>A</span>
              <span className="rte-bar" style={{ background: color }} />
            </span>
          </ToolBtn>
          <ToolBtn label="Choose text color" pressed={menu === "color"} onPress={() => setMenu(menu === "color" ? null : "color")} style={{ minWidth: 20, padding: 0 }}>
            <Chevron />
          </ToolBtn>
          {menu === "color" && (
            <div ref={pop} className="rte-pop" role="group" aria-label="Text colors" style={{ gridTemplateColumns: "repeat(5, 28px)" }}>
              {TEXT_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className="rte-swatch"
                  aria-label={`Text color: ${c.label}`}
                  title={c.label}
                  aria-pressed={c.value === color}
                  onMouseDown={keepSelection}
                  onClick={() => applyColor(c.value)}
                  style={{ color: c.value }}
                >
                  A
                </button>
              ))}
            </div>
          )}
        </span>

        <span className="rte-split">
          <ToolBtn label="Highlight" keys={`${MOD}Shift+H`} onPress={() => applyMark(mark)}>
            <span className="rte-glyph">
              <Marker />
              <span className="rte-bar" style={{ background: mark }} />
            </span>
          </ToolBtn>
          <ToolBtn label="Choose highlight color" pressed={menu === "highlight"} onPress={() => setMenu(menu === "highlight" ? null : "highlight")} style={{ minWidth: 20, padding: 0 }}>
            <Chevron />
          </ToolBtn>
          {menu === "highlight" && (
            <div ref={pop} className="rte-pop" role="group" aria-label="Highlight colors" style={{ gridTemplateColumns: "repeat(4, 28px)" }}>
              {HIGHLIGHTS.map((h) => (
                <button
                  key={h.value}
                  type="button"
                  className="rte-swatch"
                  aria-label={h.value === "transparent" ? "Remove highlight" : `Highlight: ${h.label}`}
                  title={h.value === "transparent" ? "No highlight" : h.label}
                  aria-pressed={h.value === mark}
                  onMouseDown={keepSelection}
                  onClick={() => applyMark(h.value)}
                  style={{ background: h.value === "transparent" ? "var(--color-surface)" : h.value }}
                >
                  {h.value === "transparent" ? <NoMark /> : null}
                </button>
              ))}
            </div>
          )}
        </span>

        <span className="rte-split">
          <ToolBtn label="Text size" pressed={menu === "size"} onPress={() => setMenu(menu === "size" ? null : "size")}>
            <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: 0 }}>A<span style={{ fontSize: 17 }}>A</span></span>
            <Chevron />
          </ToolBtn>
          {menu === "size" && (
            <div ref={pop} className="rte-pop rte-pop-list" role="group" aria-label="Text sizes">
              {TEXT_SIZES.map((t) => (
                <button key={t.step} type="button" className="rte-item" onMouseDown={keepSelection} onClick={() => applySize(t.step)} style={{ fontSize: t.css === "medium" ? 15 : t.css }}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className="rte-sep" aria-hidden />

        <ToolBtn pressed={active.has("insertUnorderedList")} onPress={() => exec("insertUnorderedList")} label="Bulleted list"><ListIcon /></ToolBtn>
        <ToolBtn pressed={active.has("insertOrderedList")} onPress={() => exec("insertOrderedList")} label="Numbered list"><NumberedIcon /></ToolBtn>
        <ToolBtn label="Clear formatting" keys={`${MOD}\\`} onPress={() => exec("removeFormat")}><ClearIcon /></ToolBtn>
      </div>
      <div
        ref={area}
        className="rte-area"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        data-empty={empty || undefined}
        spellCheck
        onInput={emit}
        onKeyDown={onKey}
        onPaste={onPaste}
        style={{ minHeight }}
      />
    </div>
  );
}

/** A note's body as it reads: formatted when its html is current, plain text otherwise. */
export function RichText({ body, html, style }: { body: string; html?: string; style?: CSSProperties }) {
  const clean = useMemo(() => noteHtml(body, html), [body, html]);
  if (!clean) return <p className="rte-view" style={{ margin: 0, ...style }}>{body}</p>;
  return <div className="rte-view" style={style} dangerouslySetInnerHTML={{ __html: clean }} />;
}

/** Toolbar presses must not move focus out of the text box, or the selection they act on is gone. */
function keepSelection(e: MouseEvent) {
  e.preventDefault();
}

function ToolBtn({ label, keys, pressed, onPress, style, children }: { label: string; keys?: string; pressed?: boolean; onPress: () => void; style?: CSSProperties; children: ReactNode }) {
  return (
    <button type="button" className="rte-btn" aria-label={label} title={keys ? `${label} (${keys})` : label} aria-pressed={pressed} onMouseDown={keepSelection} onClick={onPress} style={style}>
      {children}
    </button>
  );
}

const ico = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

function Chevron() {
  return (
    <svg {...ico} width={12} height={12} strokeWidth={2.4}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function Marker() {
  return (
    <svg {...ico} width={16} height={16}>
      <path d="m14.5 4.5 5 5-8 8H8.5L6.5 15.5v-3z" />
      <path d="m11.5 7.5 5 5" />
      <path d="M6.5 15.5 4 18h4.5" />
    </svg>
  );
}
function NoMark() {
  return (
    <svg {...ico} width={16} height={16} style={{ color: "var(--color-danger)" }}>
      <path d="M6 18 18 6" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg {...ico}>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <circle cx="5" cy="6" r="1.1" fill="currentColor" />
      <circle cx="5" cy="12" r="1.1" fill="currentColor" />
      <circle cx="5" cy="18" r="1.1" fill="currentColor" />
    </svg>
  );
}
function NumberedIcon() {
  return (
    <svg {...ico}>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M4 5l1.5-1v4" strokeWidth={1.5} />
      <path d="M3.8 11.2c.3-.6 1.9-.8 1.9.3 0 .8-1.9 1.6-1.9 2.5h2" strokeWidth={1.5} />
      <path d="M3.9 16.6c.5-.5 1.9-.4 1.9.4s-1.1.6-1.1.6 1.3 0 1.3.9c0 .9-1.6 1-2.1.4" strokeWidth={1.5} />
    </svg>
  );
}
function ClearIcon() {
  return (
    <svg {...ico}>
      <path d="M6 5h11M11.5 5 8 19" />
      <path d="m14 14 5 5M19 14l-5 5" />
    </svg>
  );
}
