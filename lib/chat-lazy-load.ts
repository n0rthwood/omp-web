// Scroll-position preservation for prepended history pages (#99). The old
// 50-message render window / IntersectionObserver auto-load is gone: history
// pages in through an explicit button over the journal routes, and these two
// helpers keep the viewport stable when a page lands above it.

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}