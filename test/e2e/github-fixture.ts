import { createServer } from 'node:http';
import { join } from 'node:path';
import { FEATURE_BRANCH, MAIN_BRANCH } from '../fixture/repo.js';
import { quiet } from './server.js';

const remote = 'https://github.com/o/tally';
export const prUrl = `${remote}/pull/7`;
export const path = 'tally/currency.py';

function comment(id: string, body: string, login = 'reviewer', pending = false) {
  return {
    id,
    body,
    createdAt: '2024-05-31T00:00:00Z',
    url: `${prUrl}#discussion-${id}`,
    author: { login },
    state: pending ? 'PENDING' : 'SUBMITTED',
    viewerDidAuthor: login === 'reviewer',
    viewerCanDelete: pending,
    viewerCanUpdate: pending,
    databaseId: Number(id),
    pullRequest: { url: prUrl },
  };
}

function thread(id: string, line: number, comments: ReturnType<typeof comment>[], file = path) {
  return {
    id,
    path: file,
    line: id === 'outdated' ? null : line,
    startLine: null,
    originalLine: line,
    originalStartLine: null,
    diffSide: 'RIGHT',
    isResolved: id === 'resolved',
    isOutdated: id === 'outdated',
    comments,
  };
}

const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

/** Git data comes from a local remote. Only GitHub's HTTP API is simulated. */
export async function githubFixture(repo: string) {
  const git = (...args: string[]) => quiet('git', args, repo).trim();
  const origin = join(repo, '.git', 'fixture-origin').replaceAll('\\', '/');
  git('clone', '--bare', '.', origin);
  const headRefOid = git('rev-parse', FEATURE_BRANCH);
  const baseRefOid = git('rev-parse', MAIN_BRANCH);
  git('--git-dir', origin, 'update-ref', 'refs/pull/7/head', headRefOid);
  git('remote', 'add', 'origin', remote);
  git('config', `url.${origin}.insteadOf`, remote);

  const pull = {
    id: 'pr-7',
    number: 7,
    url: prUrl,
    title: 'Improve feature',
    state: 'OPEN',
    isDraft: false,
    baseRefOid,
    headRefOid,
    baseRefName: MAIN_BRANCH,
    headRefName: FEATURE_BRANCH,
    headRepository: { name: 'tally', owner: { login: 'o' } },
  };
  const threads = [
    thread('active', 20, [
      comment('1', 'Why does this use three places?'),
      comment('2', 'This currency needs three places.', 'author'),
    ]),
    thread('resolved', 18, [comment('3', 'Resolved discussion')]),
    thread('outdated', 19, [comment('4', 'Outdated discussion')]),
  ];
  let reviewId: string | null = null;
  let id = 5;
  const submitted: { summary: string; comments: string[] }[] = [];
  const all = () => threads.flatMap((item) => item.comments);
  const inPull = (value: object) => ({ repository: { pullRequest: value } });
  const permissions = (item: (typeof threads)[number]) => ({
    viewerCanReply: true,
    viewerCanResolve: !item.isResolved,
    viewerCanUnresolve: item.isResolved,
  });

  function graphql(query: string, variables: ParametersForGithub['variables']) {
    const input = variables.input ?? {};
    if (query.includes('viewer{login}')) {
      return {
        viewer: { login: 'reviewer' },
        ...inPull({
          id: pull.id,
          reviews: { nodes: reviewId ? [{ id: reviewId, author: { login: 'reviewer' } }] : [] },
        }),
      };
    }
    if (query.includes('reviewThreads(')) {
      return inPull({
        reviewThreads: page(
          threads.map(({ comments, ...item }) => ({
            ...item,
            ...permissions({ ...item, comments }),
            pullRequest: { headRefOid },
            replies: page(comments),
          })),
        ),
      });
    }
    if (query.includes('reviews(')) return inPull({ reviews: page([]) });
    if (query.includes('comments(first:30')) return inPull({ comments: page([]) });
    if (query.includes('files(first:100')) return inPull({ ...pull, files: page([]) });
    if (query.includes('number url title')) return inPull(pull);
    if (query.includes('on PullRequestReviewThread')) {
      const item = threads.find((candidate) => candidate.id === variables.id);
      return { node: item ? { ...item, ...permissions(item), pullRequest: pull } : null };
    }
    if (query.includes('on PullRequestReviewComment')) return { node: all().find((item) => item.id === variables.id) };
    if (query.includes('updatePullRequestReviewComment(')) {
      const target = all().find((item) => item.id === input.pullRequestReviewCommentId && item.state === 'PENDING');
      if (target && input.body?.trim()) {
        target.body = input.body;
        return { updatePullRequestReviewComment: { pullRequestReviewComment: { id: target.id } } };
      }
    }
    if (
      query.includes('addPullRequestReview(') &&
      !reviewId &&
      input.pullRequestId === pull.id &&
      input.commitOID === headRefOid
    ) {
      reviewId = 'pending-review';
      for (const draft of input.threads ?? []) {
        const message = comment(String(id++), draft.body, 'reviewer', true);
        threads.push(thread(`new-${message.id}`, draft.line, [message], draft.path));
      }
      return { addPullRequestReview: { pullRequestReview: { id: reviewId } } };
    }
    if (query.includes('addPullRequestReviewThreadReply(') && reviewId && input.pullRequestReviewId === reviewId) {
      const target = threads.find((item) => item.id === input.pullRequestReviewThreadId);
      if (target && input.body?.trim()) {
        const reply = comment(String(id++), input.body, 'reviewer', true);
        target.comments.push(reply);
        return { addPullRequestReviewThreadReply: { comment: reply } };
      }
    }
    const resolution = query.match(/\b(unresolveReviewThread|resolveReviewThread)\(/)?.[1];
    if (resolution) {
      const target = threads.find((item) => item.id === input.threadId);
      if (target) {
        target.isResolved = resolution === 'resolveReviewThread';
        return { [resolution]: { thread: target } };
      }
    }
    if (
      query.includes('submitPullRequestReview(') &&
      reviewId &&
      input.pullRequestReviewId === reviewId &&
      input.event === 'COMMENT'
    ) {
      const comments = all().filter((item) => item.state === 'PENDING');
      submitted.push({ summary: input.body ?? '', comments: comments.map((item) => item.body) });
      for (const item of comments) {
        item.state = 'SUBMITTED';
        item.viewerCanDelete = false;
        item.viewerCanUpdate = false;
      }
      const submittedId = reviewId;
      reviewId = null;
      return { submitPullRequestReview: { pullRequestReview: { id: submittedId } } };
    }
    throw new Error(`Unexpected GitHub operation: ${query}`);
  }

  const server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      const databaseId = Number(req.url?.match(/^\/repos\/o\/tally\/pulls\/comments\/(\d+)$/)?.[1]);
      for (const item of threads) {
        const index = item.comments.findIndex(
          (message) => message.databaseId === databaseId && message.state === 'PENDING',
        );
        if (index === -1) continue;
        item.comments.splice(index, 1);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8').on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      try {
        const { query, variables } = JSON.parse(body) as ParametersForGithub;
        res.end(JSON.stringify({ data: graphql(query, variables) }));
      } catch (error) {
        res.end(JSON.stringify({ errors: [{ message: String(error) }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('GitHub fixture needs a TCP port');
  return {
    submitted,
    addReply(body: string) {
      threads[0]!.comments.push(comment(String(id++), body, 'author'));
    },
    env: { GITHUB_API_URL: `http://127.0.0.1:${address.port}`, GITHUB_TOKEN: 'fixture-token' },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface ParametersForGithub {
  query: string;
  variables: {
    id?: string;
    input?: {
      pullRequestId?: string;
      commitOID?: string;
      pullRequestReviewId?: string;
      pullRequestReviewThreadId?: string;
      pullRequestReviewCommentId?: string;
      threadId?: string;
      body?: string;
      event?: string;
      threads?: { path: string; line: number; body: string }[];
    };
  };
}
