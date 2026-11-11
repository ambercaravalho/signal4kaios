

export function Reactions(props: { reactions: Record<string, string> }) {
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const e of Object.values(props.reactions || {})) {
    if (!counts[e]) order.push(e);
    counts[e] = (counts[e] || 0) + 1;
  }
  if (!order.length) return null;
  return (
    <div class="msg-reactions">
      {order.map((e) => (
        <span key={e} class="msg-reaction">
          <span class="emoji">{e}</span>
          {counts[e] > 1 && <span class="msg-reaction-count">{counts[e]}</span>}
        </span>
      ))}
    </div>
  );
}
