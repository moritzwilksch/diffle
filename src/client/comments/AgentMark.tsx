import { Bot } from 'lucide-react';

/** Marks a message the reviewer's agent wrote, in a thread's header or on its own message row; `size` sets text and icon. */
export function AgentMark({ size }: { size: string }) {
  return (
    <span className="inline-flex items-center gap-0.75 font-sans leading-[normal] text-accent" style={{ fontSize: size }}>
      <Bot size={size} /> agent
    </span>
  );
}
