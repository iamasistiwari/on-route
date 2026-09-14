// Minimal inline SVG icons (codicons are not available without external fonts).
const PATHS = {
  x: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z',
  eyeOff: 'M2 2l12 12M6.6 6.6A2 2 0 009.4 9.4M4.2 4.7C2.5 5.9 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.4-.4 3.3-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2',
  gear: 'M8 10.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  chevronRight: 'M6 3.5L10.5 8 6 12.5',
  chevronDown: 'M3.5 6L8 10.5 12.5 6',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
  check: 'M3 8.5l3.2 3L13 4.5',
  fontSize: 'M1.5 13L5 3.5h.6L9 13M2.8 9.8h5M10 13l2.3-6h.4l2.3 6M10.7 11.2h3.6',
  wrap: 'M2 4h12M2 8h9.5a2 2 0 010 4H8m0 0l1.5-1.5M8 12l1.5 1.5M2 12h3',
  search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM10.5 10.5L14 14',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 015 0v2.5',
  unlock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 014.8-1',
  folder: 'M1.5 3.5h4.5l1.5 1.5h7v8h-13z',
  folderOpen: 'M1.5 13V3.5h4.5l1.5 1.5h5.5v2M1.5 13l2-6h11l-2 6z',
  newFolder: 'M1.5 3.5h4.5l1.5 1.5h7v8h-13zM8 7v4M6 9h4',
  key: 'M5.5 10.5a3 3 0 110-6 3 3 0 010 6zM8.3 7.5h6.2M12.5 7.5v2M14.5 7.5v1.5',
  braces: 'M5.5 2.5c-1.5 0-2 .7-2 2v1.8c0 .9-.6 1.7-1.5 1.7.9 0 1.5.8 1.5 1.7v1.8c0 1.3.5 2 2 2M10.5 2.5c1.5 0 2 .7 2 2v1.8c0 .9.6 1.7 1.5 1.7-.9 0-1.5.8-1.5 1.7v1.8c0 1.3-.5 2-2 2',
  layers: 'M8 2l6.5 3.5L8 9 1.5 5.5zM1.5 8.5L8 12l6.5-3.5M1.5 11L8 14.5 14.5 11',
  endpoints: 'M2.5 4h2M2.5 8h2M2.5 12h2M6.5 4h7M6.5 8h7M6.5 12h7',
  history: 'M2.5 8a5.5 5.5 0 101.6-3.9M2 2.5v2.5h2.5M8 5v3l2 1.5',
  warning: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.5',
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
  list: 'M2 4h12M2 8h12M2 12h12',
  text: 'M3 4h10M3 8h10M3 12h6',
  more: 'M3.4 8h.2M7.9 8h.2M12.4 8h.2',
  terminal: 'M2 3h12v10H2zM4.5 6.5L6.5 8l-2 1.5M8 10h3',
  pencil: 'M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3',
  open: 'M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v4H2.5V4h4',
  send: 'M14 2L7 9M14 2l-4.5 12L7 9 2 6.5z',
  panelLeft: 'M2 3h12v10H2zM6.5 3v10',
  panelTop: 'M2 3h12v10H2zM2 7.5h12',
  radar: 'M14.5 8A6.5 6.5 0 1 1 8 1.5M11.5 8A3.5 3.5 0 1 1 8 4.5M8 8l4.6-4.6M8 8.01h.01',
  arrowUp: 'M8 13V3M4 7l4-4 4 4',
  arrowDown: 'M8 3v10M4 9l4 4 4-4',
  plug: 'M6 1.5v3M10 1.5v3M4 4.5h8V7a4 4 0 01-8 0zM8 11v3.5',
  pin: 'M6 2h4M6.5 2v3.3c0 .7-.3 1.4-.8 1.9L4.3 8.7c-.4.4-.1 1 .4 1h6.6c.5 0 .8-.6.4-1L10.3 7.2c-.5-.5-.8-1.2-.8-1.9V2M8 9.7V14',
  pinOff: 'M6 2h4M6.5 2v3.3c0 .7-.3 1.4-.8 1.9L4.3 8.7c-.4.4-.1 1 .4 1h6.6c.5 0 .8-.6.4-1L10.3 7.2c-.5-.5-.8-1.2-.8-1.9V2M8 9.7V14M3 3l10 10',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 2.2 : 1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
