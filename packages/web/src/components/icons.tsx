/**
 * Icon set.
 *
 * Hand-drawn on a 16×16 grid with a 1.5 stroke, rather than pulled from a
 * package: the set is small, it keeps the bundle free of an icon dependency,
 * and — more importantly — a consistent optical weight is what stops a dense
 * interface from looking assembled out of parts.
 *
 * Everything inherits `currentColor` and sizes from the `size` prop.
 */

interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

function Svg({
  size = 16,
  className,
  style,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Logo: (p: IconProps) => (
    <svg
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      className={p.className}
      style={p.style}
      aria-hidden="true"
    >
      <path d="M8 1.2 14.2 8 8 14.8 1.8 8 8 1.2Z" fill="#fff" fillOpacity={0.94} />
      <path d="M8 4.6 11.4 8 8 11.4 4.6 8 8 4.6Z" fill="#6b6fe8" />
    </svg>
  ),

  Bell: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 6a4 4 0 1 0-8 0c0 3.2-1.2 4.2-1.2 4.2h10.4S12 9.2 12 6Z" />
      <path d="M9.2 12.8a1.4 1.4 0 0 1-2.4 0" />
    </Svg>
  ),

  Users: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10.7 13.5v-1.2a2.4 2.4 0 0 0-2.4-2.4H4.1a2.4 2.4 0 0 0-2.4 2.4v1.2" />
      <circle cx="6.2" cy="5.1" r="2.4" />
      <path d="M14.3 13.5v-1.2a2.4 2.4 0 0 0-1.8-2.3M10.9 2.8a2.4 2.4 0 0 1 0 4.6" />
    </Svg>
  ),

  Room: (p: IconProps) => (
    <Svg {...p}>
      <path d="M13.8 9.6a1.6 1.6 0 0 1-1.6 1.6H4.6L1.8 14V3.4a1.6 1.6 0 0 1 1.6-1.6h8.8a1.6 1.6 0 0 1 1.6 1.6v6.2Z" />
    </Svg>
  ),

  Pulse: (p: IconProps) => (
    <Svg {...p}>
      <path d="M1.5 8h3l2-5 3 10 2-5h3" />
    </Svg>
  ),

  Board: (p: IconProps) => (
    <Svg {...p}>
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="1.6" />
      <path d="M5.8 2.2v11.6M10.2 2.2v11.6" />
    </Svg>
  ),

  Share: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12.4" cy="3.6" r="1.9" />
      <circle cx="3.6" cy="8" r="1.9" />
      <circle cx="12.4" cy="12.4" r="1.9" />
      <path d="M5.3 7.1 10.7 4.5M5.3 8.9l5.4 2.6" />
    </Svg>
  ),

  Memory: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 2.2a2.3 2.3 0 0 0-2.3 2.3v.2a2 2 0 0 0-1.5 3.3A2.1 2.1 0 0 0 5.4 11a2.2 2.2 0 0 0 2.6 2.1V2.2Z" />
      <path d="M8 2.2a2.3 2.3 0 0 1 2.3 2.3v.2a2 2 0 0 1 1.5 3.3A2.1 2.1 0 0 1 10.6 11 2.2 2.2 0 0 1 8 13.1" />
    </Svg>
  ),

  File: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9.2 1.6H4.6a1.5 1.5 0 0 0-1.5 1.5v9.8a1.5 1.5 0 0 0 1.5 1.5h6.8a1.5 1.5 0 0 0 1.5-1.5V5.2L9.2 1.6Z" />
      <path d="M9 1.8v3.5h3.6M5.8 9h4.4M5.8 11.2h3" />
    </Svg>
  ),

  Send: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14.2 1.8 7.4 8.6M14.2 1.8l-4.4 12.4-2.4-5.6-5.6-2.4 12.4-4.4Z" />
    </Svg>
  ),

  Spark: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 1.6 9.5 6l4.4 1.5L9.5 9 8 13.4 6.5 9 2.1 7.5 6.5 6 8 1.6Z" />
    </Svg>
  ),

  Play: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4.4 2.6 12.8 8l-8.4 5.4V2.6Z" />
    </Svg>
  ),

  Pause: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5.8 2.8v10.4M10.2 2.8v10.4" />
    </Svg>
  ),

  Stop: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.4" />
    </Svg>
  ),

  Check: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.8 8.4 6.2 11.8l7-7.6" />
    </Svg>
  ),

  X: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  ),

  Plus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Svg>
  ),

  Arrow: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.8 8h10.4M9.2 4l4 4-4 4" />
    </Svg>
  ),

  Back: (p: IconProps) => (
    <Svg {...p}>
      <path d="M13.2 8H2.8M6.8 4l-4 4 4 4" />
    </Svg>
  ),

  Down: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6.2 8 10.2l4-4" />
    </Svg>
  ),

  Search: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="7.2" cy="7.2" r="4.6" />
      <path d="M10.6 10.6 13.8 13.8" />
    </Svg>
  ),

  Tool: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10.6 5.4a2.8 2.8 0 0 1-3.7 3.7l-4 4a1.3 1.3 0 0 1-1.9-1.9l4-4a2.8 2.8 0 0 1 3.7-3.7L7.1 5.1l1.2 2.3 2.3-2Z" />
    </Svg>
  ),

  Lock: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.2" y="7" width="9.6" height="7" rx="1.5" />
      <path d="M5.4 7V4.8a2.6 2.6 0 0 1 5.2 0V7" />
    </Svg>
  ),

  Warn: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 2.4 14.4 13.2H1.6L8 2.4Z" />
      <path d="M8 6.6v2.8M8 11.4h.01" />
    </Svg>
  ),

  Info: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.4v3.4M8 5.4h.01" />
    </Svg>
  ),

  Flag: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.4 10s.6-.6 2.3-.6 2.8 1.2 4.5 1.2 2.4-.6 2.4-.6V3.2s-.7.6-2.4.6S7.4 2.6 5.7 2.6 3.4 3.2 3.4 3.2V14" />
    </Svg>
  ),

  Target: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.2" />
      <circle cx="8" cy="8" r="3.4" />
      <circle cx="8" cy="8" r="0.8" fill="currentColor" />
    </Svg>
  ),

  Enter: (p: IconProps) => (
    <Svg {...p}>
      <path d="M13.2 3.2v4a2 2 0 0 1-2 2H3.2" />
      <path d="M6.4 6 3.2 9.2l3.2 3.2" />
    </Svg>
  ),

  Exit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 14H3.4A1.4 1.4 0 0 1 2 12.6V3.4A1.4 1.4 0 0 1 3.4 2H6" />
      <path d="M10.4 11.2 13.6 8l-3.2-3.2M13.6 8H6" />
    </Svg>
  ),

  Dots: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="8" cy="3.4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12.6" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  ),

  Pin: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6.2 1.8h3.6l-.5 4 2.3 2.2v1.2H4.4V8l2.3-2.2-.5-4ZM8 9.2V14" />
    </Svg>
  ),

  Edit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 13.4H14" />
      <path d="M11 2.6a1.6 1.6 0 0 1 2.3 2.3L5.4 12.8l-3 .8.8-3 7.8-8Z" />
    </Svg>
  ),

  Trash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.6 4.2h10.8M5.4 4.2V3a1.2 1.2 0 0 1 1.2-1.2h2.8A1.2 1.2 0 0 1 10.6 3v1.2" />
      <path d="M12.2 4.2v9a1.2 1.2 0 0 1-1.2 1.2H5a1.2 1.2 0 0 1-1.2-1.2v-9" />
    </Svg>
  ),

  Clock: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4V8l2.4 1.4" />
    </Svg>
  ),

  Link: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6.6 8.6a2.6 2.6 0 0 0 3.9.3l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
      <path d="M9.4 7.4a2.6 2.6 0 0 0-3.9-.3L3.9 8.7a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
    </Svg>
  ),
};

export type IconName = keyof typeof Icon;
