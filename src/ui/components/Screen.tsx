import type { ComponentChildren } from 'preact';
import { useMarquee } from '../app/focus';
import { currentSoftkeys, useIsTop, useRouterVersion } from '../app/router';

/** A full screen: KaiOS header and a scrolling body. */
export function Screen(props: { title: string; banner?: ComponentChildren; children?: ComponentChildren; bodyClass?: string }) {
  const top = useIsTop();
  const titleRef = useMarquee<HTMLDivElement>(top, props.title);
  return (
    <div class="screen">
      <div class="hdr">
        <div class="marquee-text" ref={titleRef}>
          {props.title}
        </div>
      </div>
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
