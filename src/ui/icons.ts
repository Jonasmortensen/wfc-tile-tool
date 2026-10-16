const svg = (body: string) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const dot = (cx: number, cy: number, r = 0.7) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

export const ICONS = {
  open: svg('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>'),
  import: svg('<path d="M12 15V4m-4 4 4-4 4 4"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>'),
  export: svg('<path d="M12 4v11m-4-4 4 4 4-4"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>'),
  help: svg(`<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.5"/>${dot(12, 17, 0.9)}`),
  dice: svg(`<rect x="4" y="4" width="16" height="16" rx="3.5"/>${dot(9, 9, 1.3)}${dot(15, 9, 1.3)}${dot(9, 15, 1.3)}${dot(15, 15, 1.3)}`),
  alert: svg(`<path d="M10.3 4.6 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/>${dot(12, 17, 0.9)}`),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>'),
  info: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/>${dot(12, 8, 0.9)}`),
  filter: svg('<path d="M4 5.5h16l-6.2 7.2V19l-3.6-1.8v-4.5z"/>'),
  reset: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>'),
  x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  cube: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
  cull: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9" stroke-dasharray="2 2.2"/>'),
};

export type IconName = keyof typeof ICONS;

/** Fill every `[data-icon]` element under `root` with its icon, before its text. */
export function injectIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const icon = ICONS[el.dataset.icon as IconName];
    if (icon && !el.querySelector(':scope > svg.ic')) el.insertAdjacentHTML('afterbegin', icon);
  });
}
