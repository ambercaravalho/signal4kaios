import * as store from '../../data/store';
import type { ContactCard } from '../../data/types';
import { Icon } from '../Icon';

export function ContactCardView(props: { card: ContactCard }) {
  const { card } = props;
  const title = card.name || card.phones[0] || card.emails[0];
  const sub = card.name ? card.phones[0] || card.emails[0] : '';
  return (
    <div class="msg-file">
      <Icon name="person" />
      <span class="msg-file-name">{title}</span>
      {sub ? <span class="msg-file-size">{sub}</span> : null}
    </div>
  );
}

/** The Signal user a shared contact's number belongs to, when it's someone we already know. */
export function cardContact(card: ContactCard) {
  return store.contactsList().find((c) => !!c.uuid && !!c.number && card.phones.some((p) => p.replace(/[\s()-]/g, '') === c.number));
}
