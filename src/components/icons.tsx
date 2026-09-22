import type { CSSProperties, JSX, ReactNode } from "react";

/**
 * Violet Glass icon set — seven original glyphs drawn on a 24×24 grid.
 *
 * Style rules (shared by every glyph):
 *  - rounded 1.6px outlines in the lavender accent (`--color-primary`)
 *  - the main body of each glyph is filled with the same lavender at 20%,
 *    so it reads as a lit glass object on the dark UI
 *  - a few small detail strokes use a lighter lavender tint
 *  - every shape stays ≥1.5px inside the 24×24 box (stroke included)
 */

export type IconName =
  | "overview"
  | "reminders"
  | "calendar"
  | "notes"
  | "files"
  | "crm"
  | "customers";

export const ICON_NAMES: IconName[] = [
  "overview",
  "reminders",
  "calendar",
  "notes",
  "files",
  "crm",
  "customers",
];

const PRIMARY = "var(--color-primary)";
const LIGHT = "rgba(217,204,255,0.9)";
const GLASS = 0.2;

const GLYPHS: Record<IconName, ReactNode> = {
  // Layered window tiles: a back window peeking out behind a filled front window
  // that carries a title-bar line.
  overview: (
    <>
      <path d="M7.5 8V5.5a2.5 2.5 0 0 1 2.5-2.5h8.5a2.5 2.5 0 0 1 2.5 2.5V11a2.5 2.5 0 0 1-2.5 2.5H17" />
      <rect x="3" y="8" width="14" height="13" rx="2.5" fill={PRIMARY} fillOpacity={GLASS} />
      <path d="M4 12.5h12" stroke={LIGHT} />
    </>
  ),

  // Soft bell: a domed, filled bell body with a rounded lip and a small
  // clapper ring hanging below it.
  reminders: (
    <>
      <path
        d="M12 3c-3.3 0-5.5 2.4-5.5 5.8v3.9c0 1.1-.5 2-1.3 2.8-.6.6-.2 1.5.7 1.5h12.2c.9 0 1.3-.9.7-1.5-.8-.8-1.3-1.7-1.3-2.8V8.8c0-3.4-2.2-5.8-5.5-5.8Z"
        fill={PRIMARY}
        fillOpacity={GLASS}
      />
      <path d="M10.2 19.5a1.8 1.8 0 0 0 3.6 0" stroke={LIGHT} />
    </>
  ),

  // Rounded calendar tile: outlined body, filled header band, two binding
  // pegs through the top edge and three day dots.
  calendar: (
    <>
      <path d="M3 10.5V8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v2.5Z" fill={PRIMARY} fillOpacity={GLASS} stroke="none" />
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10.5h18" />
      <path d="M8 3v4M16 3v4" />
      <circle cx="8" cy="15.75" r="1.15" fill={LIGHT} stroke="none" />
      <circle cx="12" cy="15.75" r="1.15" fill={LIGHT} stroke="none" />
      <circle cx="16" cy="15.75" r="1.15" fill={LIGHT} stroke="none" />
    </>
  ),

  // Folded note sheet: filled rounded sheet with a turned-up corner at the
  // bottom-right and two short text lines.
  notes: (
    <>
      <path
        d="M6.5 3.5h11A2.5 2.5 0 0 1 20 6v9l-5.5 5.5h-8A2.5 2.5 0 0 1 4 18V6a2.5 2.5 0 0 1 2.5-2.5Z"
        fill={PRIMARY}
        fillOpacity={GLASS}
      />
      <path d="M14.5 20.5V17.5a2.5 2.5 0 0 1 2.5-2.5H20" stroke={LIGHT} />
      <path d="M8 9h8M8 13h5" stroke={LIGHT} />
    </>
  ),

  // Curved paperclip: one continuous wire (big bottom loop, top loop, small
  // inner loop) over a translucent silhouette of the outer loop, tilted 30°.
  files: (
    <g transform="rotate(30 12 12)">
      <path d="M7.5 9v7.5a4.5 4.5 0 0 0 9 0V6a3 3 0 0 0-6 0v3Z" fill={PRIMARY} fillOpacity={GLASS} stroke="none" />
      <path d="M7.5 9v7.5a4.5 4.5 0 0 0 9 0V6a3 3 0 0 0-6 0v10.5a1.5 1.5 0 0 0 3 0V9" />
    </g>
  ),

  // Linked orbit rings: two crossed, glass-filled elliptical orbits around a
  // solid centre node, with two lighter satellite nodes riding one orbit.
  crm: (
    <>
      <ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(-35 12 12)" fill={PRIMARY} fillOpacity={GLASS} />
      <ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(35 12 12)" fill={PRIMARY} fillOpacity={GLASS} />
      <circle cx="12" cy="12" r="2.3" fill={PRIMARY} stroke="none" />
      <circle cx="19.8" cy="6.5" r="1.2" fill={LIGHT} stroke="none" />
      <circle cx="4.2" cy="17.5" r="1.2" fill={LIGHT} stroke="none" />
    </>
  ),

  // Overlapping ID cards: a back card peeking out behind a filled front card
  // that carries an avatar dot and a name line.
  customers: (
    <>
      <path d="M6 9V6.5A2.5 2.5 0 0 1 8.5 4h10A2.5 2.5 0 0 1 21 6.5v6a2.5 2.5 0 0 1-2.5 2.5H18" />
      <rect x="3" y="9" width="15" height="11" rx="2.5" fill={PRIMARY} fillOpacity={GLASS} />
      <circle cx="7.5" cy="14.5" r="1.9" fill={LIGHT} stroke="none" />
      <path d="M11.5 14.5h3.5" stroke={LIGHT} />
    </>
  ),
};

interface IconProps {
  name: IconName;
  /** Rendered width/height in px (viewBox is always 24×24). */
  size?: number;
  /** Accessible label; when omitted the icon is decorative and hidden from AT. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 20, title, className, style }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={PRIMARY}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      shapeRendering="geometricPrecision"
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable={title ? undefined : "false"}
    >
      {title ? <title>{title}</title> : null}
      {GLYPHS[name]}
    </svg>
  );
}
