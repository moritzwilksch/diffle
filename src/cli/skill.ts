/**
 * The agent-facing guide printed by `diffle --skill`. Written for an agent, not a
 * human: how to get the human's review of a diff and read it back with the fewest
 * commands. `test/cli/skill.test.ts` checks that every command and flag named here
 * still exists.
 */
export const SKILL = `# diffle: get a human's review of your diff

diffle shows a git diff in the human's browser. The human comments on lines and blocks;
you read all of it back as text. Comments only ever flow from the human to you: there is
no way to post one yourself. Payloads go to stdout, status to stderr: capture stdout only.
Where "diffle" is not on PATH, the same commands run as "npx @moritzwilksch/diffle" (or
"npx ." inside the diffle checkout).

## One round

    diffle working

Starts the server, opens the browser, and blocks while the human reviews. When the human
closes diffle (Ctrl+C), the open comments are printed on stdout as a prompt. Empty stdout
with exit 0 means the human left nothing to address. Exit 2 means a bad revspec; the
reason is on stderr.

Modes: working (HEAD vs worktree, incl. untracked), pr, branch [base], or a git revspec
such as main...feat. Run inside the repository, or pass -C <path>.

Start a server only when the human asked for a review. If they are already looking at
one, wait for its output rather than starting a second: two servers on one repository
show different comments, and the human sees the one in their browser.

## Reading the prompt

One block per open comment:

    path:start-end

    > quoted lines

    the human's message

    ---

A header prefixed "(removed)" points at the old side of the diff, "(stale, was line N)" at
a comment whose text left the diff. ORIGINAL / SUGGESTED fences are the human's
replacement for the quoted lines; apply SUGGESTED. Work through every block.

## HTTP, while a review is open

Same server, read-only, no auth: GET /api/threads?state=open|resolved|all for the
comments as JSON, GET /api/threads/export for the same prompt. The human's browser holds
the port; use the URL they give you.
`;
