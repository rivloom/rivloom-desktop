import { Component, createRef, type ReactNode } from 'react';
import { activityScrollCompensation } from './conversation-activity';

type Props = { navigationKey: string; children: ReactNode };
type Snapshot = { viewport: HTMLElement; source: Node; anchor: Element | Range; top: number;
  width: number; navigationKey: string };

/** Capture before React changes the DOM. A selected paragraph must not move when
 * newly reported transfers or a published plan are inserted above it. */
export class ActivityReadingAnchor extends Component<Props, Record<string, never>, Snapshot | null> {
  private element = createRef<HTMLDivElement>();
  private beforeSpace = createRef<HTMLDivElement>();
  private afterSpace = createRef<HTMLDivElement>();
  private frame: number | null = null;
  private viewport: HTMLElement | null = null;
  private releaseSpace = () => {
    if (this.beforeSpace.current) this.beforeSpace.current.style.height = '0px';
    if (this.afterSpace.current) this.afterSpace.current.style.height = '0px';
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  };

  override componentDidMount() {
    this.viewport = this.element.current?.closest<HTMLElement>('.conversation-body') || null;
    this.viewport?.addEventListener('activity-follow-latest', this.releaseSpace);
  }

  override getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (previous.navigationKey !== this.props.navigationKey) return null;
    const root = this.element.current;
    const viewport = root?.closest<HTMLElement>('.conversation-body');
    if (!root || !viewport || !root.offsetHeight) return null;
    const bounds = viewport.getBoundingClientRect();
    const visible = (rect: DOMRect) => rect.height > 0 && rect.bottom > bounds.top + 8 && rect.top < bounds.bottom - 8;
    let anchor: Element | Range | undefined;
    let source: Node | undefined;
    const selection = window.getSelection();
    const selectedHere = !!selection?.rangeCount && !selection.isCollapsed && root.contains(selection.getRangeAt(0).commonAncestorContainer);
    if (selection?.rangeCount && !selection.isCollapsed && viewport.contains(selection.getRangeAt(0).commonAncestorContainer) && !selectedHere) return null;
    if (viewport.dataset.activityFollow === 'true' && !selectedHere) return null;
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (root.contains(range.commonAncestorContainer) && visible(range.getBoundingClientRect())) {
        anchor = range.cloneRange(); source = range.commonAncestorContainer;
      }
    }
    if (!anchor) {
      const focused = document.activeElement;
      if (focused && root.contains(focused) && visible(focused.getBoundingClientRect())) { anchor = focused; source = focused; }
    }
    if (!anchor) {
      // Reading without a selection is still reading. Prefer the first visible
      // content fragment, not the top of a large section above the viewport.
      const content = [...root.querySelectorAll('p, .trace-reasoning-body, pre, h3, summary, .activity-file-name')]
        .find(element => visible(element.getBoundingClientRect()) && element.getBoundingClientRect().top >= bounds.top - 8);
      if (content) { anchor = content; source = content; }
    }
    return anchor && source ? { viewport, anchor, source, top: anchor.getBoundingClientRect().top,
      width: viewport.clientWidth, navigationKey: this.props.navigationKey } : null;
  }

  override componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (_previous.navigationKey !== this.props.navigationKey) this.releaseSpace();
    if (!snapshot) {
      if (this.viewport?.dataset.activityFollow === 'true') this.releaseSpace();
      return;
    }
    const restore = () => {
      const { viewport, anchor, source } = snapshot;
      if (!source.isConnected || !viewport.isConnected || this.props.navigationKey !== snapshot.navigationKey
        || viewport.clientWidth !== snapshot.width) {
        this.releaseSpace();
        return;
      }
      const beforeSpace = this.beforeSpace.current, afterSpace = this.afterSpace.current;
      const after = anchor.getBoundingClientRect();
      if (!beforeSpace || !afterSpace || after.height <= 0) return;
      const retainedBefore = Number.parseFloat(beforeSpace.style.height) || 0;
      const retainedAfter = Number.parseFloat(afterSpace.style.height) || 0;
      if (Math.abs(after.top - snapshot.top) <= .5 && !retainedBefore && !retainedAfter) return;

      // At scrollTop=0, reserve the missing room above the reader. Give it
      // back when real content returns above the anchor.
      const target = activityScrollCompensation(snapshot.top, after.top, viewport.scrollTop, retainedBefore);
      if (Math.abs(target.beforeSpace - retainedBefore) > .5) beforeSpace.style.height = `${target.beforeSpace}px`;
      // At the bottom, add only enough room for the viewport to reach the
      // desired offset. Short content can be smaller than scrollHeight.
      const content = viewport.firstElementChild;
      const extent = viewport.scrollHeight > viewport.clientHeight || !content ? viewport.scrollHeight
        : content.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top + viewport.scrollTop
          + (Number.parseFloat(getComputedStyle(viewport).paddingBottom) || 0);
      const maximum = extent - viewport.clientHeight - retainedAfter;
      const missing = target.scrollTop > .5 ? target.scrollTop - maximum : 0;
      const neededAfter = missing > .5 ? Math.ceil(missing) + 1 : 0;
      if (Math.abs(neededAfter - retainedAfter) > .5) {
        afterSpace.style.height = `${neededAfter}px`;
      }
      viewport.scrollTop = target.scrollTop;
    };
    restore();
    // Parent scroll-follow effects run after child layout lifecycles. Reconcile
    // once before paint without animating the reader's scroll position.
    this.frame = requestAnimationFrame(() => { this.frame = null; restore(); });
  }

  override componentWillUnmount() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.viewport?.removeEventListener('activity-follow-latest', this.releaseSpace);
  }
  override render() {
    return <div className="activity-reading-anchor" ref={this.element}>
      <div className="activity-reading-space-before" ref={this.beforeSpace} aria-hidden="true" />
      {this.props.children}
      <div className="activity-reading-space" ref={this.afterSpace} aria-hidden="true" />
    </div>;
  }
}
