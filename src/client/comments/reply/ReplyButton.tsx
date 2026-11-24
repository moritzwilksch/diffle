import { Reply, X } from 'lucide-react';
import { Button } from '@/client/ui/Button.js';

export function ReplyButton({
  replying = false,
  onClick,
  className,
}: {
  replying?: boolean;
  onClick: () => void;
  className?: string;
}) {
  const label = replying ? 'Cancel reply' : 'Reply';
  return (
    <Button
      type="button"
      variant="ghost"
      icon
      aria-label={label}
      title={label}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      {replying ? <X size="0.875rem" /> : <Reply size="0.875rem" />}
    </Button>
  );
}
