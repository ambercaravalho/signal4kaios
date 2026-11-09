import type { ComponentChildren } from 'preact';
import { isTyping, useMarquee } from '../app/focus';
import { currentSoftkeys, useIsTop, useKeys, useRouterVersion } from '../app/router';

/** A full screen: KaiOS header, optional tabs, and a scrolling body. */
export function Screen(props: { title: string; tabs?: { labels: string[]; index: number; onChange(i: number): void }; banner?: ComponentChildren; children?: ComponentChildren; bodyClass?: string }) {
  const top = useIsTop();
  const titleRef = useMarquee<HTMLDivElement>(top, props.title);
  const tabs = props.tabs;
  useKeys((e) => {
    if (!tabs || tabs.labels.length < 2 || isTyping()) return false;
    if (e.key === 'ArrowLeft') tabs.onChange((tabs.index + tabs.labels.length - 1) % tabs.labels.length);
    else if (e.key === 'ArrowRight') tabs.onChange((tabs.index + 1) % tabs.labels.length);
    else return false;
    return true;
  });
  return (
    <div class="screen">
      <div class="hdr">
        <div class="marquee-text" ref={titleRef}>
          {props.title}
        </div>
      </div>
      {tabs && (
        <div class="tabs">
          {tabs.labels.map((l, i) => (
            <div key={l} class={'tab' + (i === tabs.index ? ' active' : '')}>
              {l}
            </div>
          ))}
        </div>
      )}
      {props.banner}
      <div class={'body' + (props.bodyClass ? ' ' + props.bodyClass : '')}>{props.children}</div>
    </div>
  );
}

/** The bar along the bottom showing the top screen's softkeys. */
export function SoftkeyBar() {
  useRouterVersion();
  const sk = currentSoftkeys();
  return (
    <div class="softkeys">
      <span class="sk sk-left">{sk.left || ''}</span>
      <span class="sk sk-center">{sk.center || ''}</span>
      <span class="sk sk-right">{sk.right || ''}</span>
    </div>
  );
}
