/**
 * The agent-facing guide printed by `diffle --skill`. Written for an agent, not a
 * human: how to seed findings, read the human's feedback, and close the loop
 * with the fewest commands. `test/cli/skill.test.ts` checks that every command
 * and flag named here still exists.
 */
export const SKILL = `# diffle: get a human's review of your diff

diffle shows a git diff in the human's browser. The human comments on lines, replies to
your findings, and resolves threads; you read all of it back as text. Payloads go to
stdout, status to stderr: capture stdout only. Where "diffle" is not on PATH, the same
commands run as "npx @moritzwilksch/diffle" (or "npx ." inside the diffle checkout).

## Find the server before starting one

    diffle comment get

Exit 0: a server is running for this repository (found through <git-dir>/diffle/server.json)
and stdout holds its open threads. Exit 1: none is running. If the human already reviewed
and closed diffle, the threads are still on disk:

    diffle export [working|pr|branch <base>|<revspec>]   # same prompt, no server; --format json, --state all

Otherwise start a server below.

The run file names the most recently started server only. When the human hands you a URL
("react to my comments at http://host:port/"), pass it to every command:

    diffle comment get --url http://host:port/

Start a second server only when the human asked for one; two servers on one repository
show different threads, and the human sees the one in their browser.

## One round, blocking

    diffle working --comment @findings.json --as <your-name>

Starts the server, seeds your findings as threads, blocks while the human reviews, and
prints the open threads as a prompt when the human closes it (Ctrl+C). Empty stdout with
exit 0 means nothing is left to address. Exit 2 means a bad payload or revspec; the
reason is on stderr. Skip --comment when you have no findings and only want feedback.

Modes: working (HEAD vs worktree, incl. untracked), pr, branch [base], or a git revspec
such as main...feat.

## Long session, detached

    diffle working --background                    # stdout: {"port","url","pid"}; --comment (incl. -) works here too
    diffle comment add @findings.json --as <name>  # {"added","skipped","threadIds"}; - or @- reads stdin
    diffle comment get                             # open threads as a prompt
    diffle comment get --format json --state all   # every thread as JSON, with ids and authors
    diffle comment reply <threadId> "<body>" --as <name>
    diffle comment resolve <threadId>...           # {"resolved","notFound"}; exit 1 if any is unknown

Run these inside the repository, or pass -C <path>. The server keeps running so the human
can keep the browser open; stop it with kill <pid> only when the human says the review is
over, or when you started it for a one-off check.

## Findings payload

One object or an array. Lines are 1-based on the new side of the diff; diffle quotes the
text itself, so send only the range.

    [{"path": "src/app.py", "startLine": 42, "endLine": 44, "body": "Batch this instead of looping."}]

Optional fields: "side": "old" for removed lines, "endLine" (defaults to startLine).
Bodies render as GitHub-flavored markdown in the viewer: **bold**, \`code\`, fenced blocks,
lists, tables. A \`\`\`suggestion fence proposes a replacement for the quoted lines.
Re-posting is safe: a finding that duplicates an open thread (same path, side, range,
body) is skipped and counted in "skipped".

## Reading the prompt

One block per open thread:

    path:start-end

    > quoted lines

    message(s)

    ---

A thread with several messages labels each one "you:" (the human) or "agent (<name>):".
A block with a single unlabelled message is either the human's comment or your own finding
the human has not answered; the JSON form tells them apart by messages[0].author. Threads
you opened and the human left alone are still open: no news is not approval.
ORIGINAL / SUGGESTED fences are the human's replacement for the quoted lines; apply
SUGGESTED. Work through every block, then "comment resolve" the threads you handled or
"comment reply" where you disagree or need more. Done means "diffle comment get" prints
nothing.

## HTTP, when the CLI is out of reach

Same server, same shapes, no auth: GET /api/threads?state=open|resolved|all,
GET /api/threads/export (the prompt), POST /api/threads (findings payload),
POST /api/threads/<id>/replies {"body","author":"agent","authorName"},
PUT /api/threads/<id>/resolved {"resolved":true}. Prefer the CLI; it handles discovery
and exit codes.
`;
