import { useLayoutEffect, useReducer, useRef, type ComponentProps, type RefObject } from 'react';

type TextAreaProps = Omit<ComponentProps<'textarea'>, 'ref' | 'value' | 'defaultValue' | 'onChange'> & {
  ref?: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onValueChange: (value: string) => void;
};

/**
 * A textarea showing `value` whose typing the browser's undo takes back in runs, not per character.
 * React's controlled textarea rewrites `defaultValue` after every keystroke, and Chromium then closes
 * the undo group. Here React never writes the text while it matches `value`: only a `value` the
 * textarea does not hold, such as a cleared draft or an inserted block, is written, which starts a new
 * history.
 */
export function TextArea({ ref, value, onValueChange, ...props }: TextAreaProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const node = ref ?? own;
  // A change can leave `value` as it was (an edit cleared to '' stores the unchanged body), and then
  // nothing above re-renders. Re-rendering here on every change still puts `value` back.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const textarea = node.current;
    if (textarea && textarea.value !== value) textarea.value = value;
  });
  return (
    <textarea
      {...props}
      ref={node}
      onChange={(e) => {
        onValueChange(e.target.value);
        rerender();
      }}
    />
  );
}
