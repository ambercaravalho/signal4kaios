import type { ComponentChildren, VNode } from 'preact';
import { useFocusScroll, useMarquee } from '../app/focus';
import { Icon } from './Icon';

export type ListEnd = 'chevron' | 'toggle' | 'radio' | 'check';

export interface ListItemProps {
  focused: boolean;
  primary: string;
  secondary?: ComponentChildren;
  /** Right side of the first line, e.g. a time. */
  meta?: ComponentChildren;
  /** Right side of the second line, e.g. an unread count. */
  badge?: ComponentChildren;
  leading?: VNode | null;
  icon?: string;
  end?: ListEnd;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  compact?: boolean;
  /** The list's first row: focusing it scrolls back to the top of the screen. */
  first?: boolean;
}

/** A KaiOS list row: one or two lines with optional avatar or icon and a trailing control. The focused row is solid accent with white text. */
export function ListItem(p: ListItemProps) {
  const ref = useFocusScroll<HTMLDivElement>(p.focused, p.first);
  const mq = useMarquee<HTMLDivElement>(p.focused, p.primary);
  const cls = 'li' + (p.focused ? ' focused' : '') + (p.danger ? ' li-danger' : '') + (p.disabled ? ' li-disabled' : '') + (p.compact ? ' li-compact' : '') + (p.end ? ' li-setting' : '');
  return (
    <div class={cls} ref={ref} role="option" aria-selected={p.focused}>
      {p.leading}
      {p.icon && <Icon name={p.icon} class="li-icon" />}
      <div class="li-text">
        <div class="li-line">
          <div class="li-primary marquee-text" ref={mq}>
            {p.primary}
          </div>
          {p.meta != null && <span class="li-meta">{p.meta}</span>}
        </div>
        {(p.secondary != null || p.badge != null) && (
          <div class="li-line">
            <div class="li-secondary">{p.secondary}</div>
            {p.badge}
          </div>
        )}
      </div>
      {p.end === 'chevron' && <Icon name="chevron" class="li-end" />}
      {p.end === 'toggle' && <span class={'switch' + (p.checked ? ' on' : '')} />}
      {p.end === 'radio' && <span class={'radio' + (p.checked ? ' on' : '')} />}
      {p.end === 'check' && <span class={'checkbox' + (p.checked ? ' on' : '')} />}
    </div>
  );
}

/** A section header, or a thin gap between groups when the label is empty. */
export function Separator(props: { label: string }) {
  return <div class={props.label ? 'sep' : 'sep sep-gap'}>{props.label}</div>;
}

export function Badge(props: { count: number }) {
  if (!props.count) return null;
  return <span class="badge">{props.count > 99 ? '99+' : props.count}</span>;
}

export function EmptyState(props: { title: string; body?: string }) {
  return (
    <div class="empty">
      <div class="empty-title">{props.title}</div>
      {props.body && <div class="empty-body">{props.body}</div>}
    </div>
  );
}

export function Spinner(props: { label?: string }) {
  return (
    <div class="spinner-wrap">
      <div class="spinner" />
      {props.label && <div class="spinner-label">{props.label}</div>}
    </div>
  );
}
