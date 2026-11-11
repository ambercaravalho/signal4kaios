/* App state and its event hub, split across `./store/`. Flow: WebSocket frame, then `parseFrame`, then `applyEvent`, then IndexedDB, then an event screens subscribe to. */

export { on, type StoreEvents } from './store/events';
export { contactByKey, contactName, contactsList, displayName, groupsList, isSelf, isSelfConv, refreshDirectory, selfNumber } from './store/contacts';
export { attachmentLabel, noticeText } from './store/previews';
export { mentionsNotifyWhileMuted, onNotificationClick, shouldNotify } from './store/notify';
export { archivedConversations, chatMedia, connectionState, conversation, conversations, conversationWith, groupConversation, init, isReady, joinedGroupConversation, openConversationId, purgeExpired, purgeExpiredConv, setConnection, setConversationName, setConvExpire, setDraft, setOpenConv, typing } from './store/conversations';
export { applyEvent, ingestRaw, MAX_EDITS } from './store/ingest';
export { markAllRead, markRead, markViewed } from './store/read';
export { forwardMessage, MAX_ATTACHMENTS, retryMessage, sendAttachments, sendEdit, sendText, type OutgoingFile } from './store/send';
export { ADMIN_DELETE_MAX_AGE, adminDelete, deleteChat, deleteForEveryone, deleteLocal, reactTo, setMessagePinned } from './store/message-actions';
export { acceptRequest, blockRequest, deleteRequest, reportSpamRequest } from './store/requests';
export { endPoll, pollCounts, sendPoll, votePoll } from './store/polls';
export { applyChatState, MAX_PINNED_CHATS, setArchived, setConvPinned, setMarkedUnread, setMentionsIfMuted, setMuted } from './store/chat-state';
export { SELF_NAME } from './store/state';
