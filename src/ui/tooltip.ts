/**
 * Hover tooltips for any element with a `data-tip` attribute (plain text, newlines kept).
 * One floating element, positioned below the target (above when there is no room).
 * After one tooltip has shown, moving to the next target shows it without the delay.
 */
export function installTooltips(el: HTMLElement) {
  let timer = 0;
  let current: HTMLElement | null = null;
  let warmUntil = 0;

  const hide = () => {
    clearTimeout(timer);
    if (el.classList.contains('show')) warmUntil = performance.now() + 400;
    el.classList.remove('show');
    current = null;
  };

  const show = (target: HTMLElement) => {
    if (!target.isConnected || !target.dataset.tip) return;
    el.textContent = target.dataset.tip;
    const r = target.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + t.height > innerHeight - 6) top = r.top - t.height - 6;
    const left = Math.min(Math.max(6, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 6);
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(6, top)}px`;
    el.classList.add('show');
  };

  document.addEventListener('pointerover', (e) => {
    const target = (e.target as Element).closest?.<HTMLElement>('[data-tip]') ?? null;
    if (target === current) return;
    hide();
    if (!target?.dataset.tip) return;
    current = target;
    const delay = performance.now() < warmUntil ? 0 : 450;
    timer = window.setTimeout(() => show(target), delay);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('scroll', hide, true);
}
