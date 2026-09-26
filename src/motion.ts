import { flushSync } from 'react-dom';

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Animates a layout change with the View Transitions API when the webview supports it
 * (WebView2); other engines and reduced-motion users get the same state change instantly.
 */
export function animateLayoutChange(update: () => void, scope = 'layout'): void {
  const doc = document as TransitionDocument;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.viewTransition = scope;
  try {
    const transition = doc.startViewTransition(() => flushSync(update));
    void transition.finished.catch(() => undefined).finally(() => {
      if (root.dataset.viewTransition === scope) delete root.dataset.viewTransition;
    });
  } catch {
    delete root.dataset.viewTransition;
    update();
  }
}
