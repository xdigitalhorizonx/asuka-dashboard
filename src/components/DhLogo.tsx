/**
 * Digital Horizon's logo mark — three centred rounded bars (pink, blue, green), the same
 * geometry as the digitalhorizon.dev header logo (viewBox 48×44, 7px round-capped lines).
 */
export function DhMark({ height = 28, title }: { height?: number; title?: string }) {
  return (
    <svg
      viewBox="0 0 48 44"
      height={height}
      width={(height * 48) / 44}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <line x1="6" y1="11" x2="42" y2="11" stroke="#F28CB4" strokeWidth="7" strokeLinecap="round" />
      <line x1="14" y1="22" x2="34" y2="22" stroke="#5EA9EA" strokeWidth="7" strokeLinecap="round" />
      <line x1="19" y1="33" x2="29" y2="33" stroke="#7ECF97" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}
