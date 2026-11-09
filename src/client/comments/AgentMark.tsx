import { Bot, BotMessageSquare, MessageSquare } from 'lucide-react';
import type { CommentThread } from '@/shared/protocol.js';

/** Marks a message the reviewer's agent wrote, in a thread's header or on its own message row; `size` sets text and icon. */
export function AgentMark({ size }: { size: string }) {
  return (
    <span
      className="inline-flex items-center gap-0.75 font-sans leading-[normal] text-accent"
      style={{ fontSize: size }}
    >
      <Bot size={size} /> agent
    </span>
  );
}

/** A thread header's icon: a bot's speech bubble when the agent opened the thread. */
export function ThreadIcon({ thread }: { thread: CommentThread }) {
  const Icon = thread.messages[0]?.author === 'agent' ? BotMessageSquare : MessageSquare;
  return <Icon size="0.8125rem" />;
}
