import type { LinkPreview } from '../../data/types';
import { AttachmentView } from './AttachmentView';

function linkDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** A link preview's image only shows once it's on the phone, under the usual download rules. */
export function LinkPreviewView(props: { preview: LinkPreview }) {
  const p = props.preview;
  return (
    <div class="msg-link">
      {p.image && <AttachmentView att={p.image} photoOnly />}
      {p.title && <div class="msg-link-title">{p.title}</div>}
      <div class="msg-link-domain">{linkDomain(p.url)}</div>
    </div>
  );
}
