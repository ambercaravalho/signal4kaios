import type { MessageStatus } from '../../data/types';
import { Icon } from '../Icon';

export function StatusIcon(props: { status: MessageStatus }) {
  const s = props.status;
  if (s === 'pending') return <Icon name="clock" class="msg-status" />;
  if (s === 'failed') return <Icon name="alert" class="msg-status msg-status-failed" />;
  if (s === 'sent') return <Icon name="check" class="msg-status" />;
  if (s === 'delivered' || s === 'read') return <Icon name="checks" class={'msg-status' + (s === 'read' ? ' msg-status-read' : '')} />;
  return null;
}
