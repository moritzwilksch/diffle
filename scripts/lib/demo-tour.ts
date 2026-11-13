// The tour the README's tour video reads: an agent's walk through the demo repository's `rate-limit`
// branch (`demo-repo-files.ts`), using every kind of block a tour offers. Its line numbers count on
// that branch's files, so a change to them moves these too; a push refuses a line the review lacks.
export const DEMO_TOUR = `
<h1>Rate-limit link creation</h1>
<p>Creating a link now spends a token from the caller's bucket. An empty bucket answers <code>429</code> with a <code>Retry-After</code> header.</p>

<h2>Where to start</h2>
<p>One new module holds the limiter; the app calls it before it stores a link.</p>
<diffle-row>
<diffle-tree title="Rate limit · Python" icon="gauge" paths="shortlink/ratelimit.py
shortlink/app.py"><diffle-file path="shortlink/ratelimit.py">start here</diffle-file></diffle-tree>
<diffle-tree title="Links · Python" icon="link" paths="shortlink/store.py
README.md"><diffle-file path="shortlink/store.py">refuses non-web addresses</diffle-file></diffle-tree>
</diffle-row>
<p>A request to <code>POST /</code> now passes the limiter before it reaches the store:</p>
<diffle-diagram><svg viewBox="0 0 680 120">
  <g step="1"><rect x="8" y="16" width="136" height="28"/><svg data-lucide="globe" x="16" y="23"/><text x="36" y="30">Client</text>
  <path d="M144 30 H184" class="arrow"/><text x="164" y="20" class="c small">POST /</text>
  <rect x="184" y="16" width="136" height="28"/><svg data-lucide="route" x="192" y="23"/><text x="212" y="30">Handler</text></g>
  <g step="2" class="accent"><path d="M320 30 H360" class="arrow"/><text x="340" y="20" class="c small">allow</text>
  <rect x="360" y="16" width="136" height="28"/><svg data-lucide="gauge" x="368" y="23"/><text x="388" y="30">Rate limiter</text></g>
  <g step="3" class="success"><path d="M496 30 H536" class="arrow"/><text x="516" y="20" class="c small">token</text>
  <rect x="536" y="16" width="136" height="28"/><svg data-lucide="database" x="544" y="23"/><text x="564" y="30">Store</text></g>
  <g step="4" class="error"><path d="M428 44 V84" class="arrow"/><text x="436" y="64" class="small">empty</text>
  <rect x="360" y="84" width="136" height="28"/><svg data-lucide="octagon-x" x="368" y="91"/><text x="388" y="98">429 Slow down</text></g>
</svg>
<diffle-note title="The request arrives">The handler reads who is calling before it parses the body.</diffle-note>
<diffle-note title="The limiter decides">Each caller has its own bucket of tokens.</diffle-note>
<diffle-note title="A token buys a link">With a token spent, the store shortens the address as before.</diffle-note>
<diffle-note title="An empty bucket refuses">The caller gets a 429 and how long to wait.</diffle-note>
</diffle-diagram>

<h2>The token bucket</h2>
<p><diffle-symbol path="shortlink/ratelimit.py" line="12" name="RateLimiter"></diffle-symbol> keeps one <diffle-symbol path="shortlink/ratelimit.py" line="6" name="Bucket"></diffle-symbol> per client and refills it from the clock on every call.</p>
<diffle-walk path="shortlink/ratelimit.py" lines="19-32">
<diffle-note lines="24-25" title="Find the bucket">A new client starts with a full bucket of <code>burst</code> tokens.</diffle-note>
<diffle-note lines="26-28" title="Refill">Tokens accrue at <code>rate</code> per second since the last call, capped at <code>burst</code>.</diffle-note>
<diffle-note lines="29-30" title="Refuse when empty">Under one token, the call spends nothing and returns <code>False</code>.</diffle-note>
<diffle-note lines="31-32" title="Spend one">Otherwise one token goes and the request passes.</diffle-note>
</diffle-walk>
<diffle-callout kind="warning"><p>The refill reads <code>time.time()</code>, the wall clock. A clock stepped back makes <code>elapsed</code> negative and drains the bucket.</p></diffle-callout>
<diffle-row>
<p>The app overrides both defaults: two links a second, in bursts of five.</p>
<table>
  <thead><tr><th>Setting</th><th>Default</th><th>In the app</th></tr></thead>
  <tbody><tr><td><code>rate</code></td><td>5 per second</td><td>2 per second</td></tr>
  <tr><td><code>burst</code></td><td>10</td><td>5</td></tr></tbody>
</table>
</diffle-row>
<p>Callers see two methods:</p>
<diffle-code path="shortlink/ratelimit.py" line="12">
class RateLimiter:
    def allow(self, client: str) -&gt; bool: ...
    def retry_after(self, client: str) -&gt; float: ...
</diffle-code>

<h2>The handler answers 429</h2>
<diffle-card id="refuse" title="Refuse before parsing" icon="shield">
  <p>The limiter runs before the body is read, so a refused request costs no JSON parsing.</p>
  <diffle-diff path="shortlink/app.py" lines="18-27"></diffle-diff>
</diffle-card>
<p>A refused request, from the handler to the header:</p>
<diffle-trace>
<diffle-stop path="shortlink/app.py" line="20">The client is the <code>x-forwarded-for</code> header, else the socket's address.</diffle-stop>
<diffle-stop path="shortlink/ratelimit.py" line="29">Its bucket holds less than one token, so <diffle-symbol path="shortlink/ratelimit.py" line="19" name="allow"></diffle-symbol> refuses.</diffle-stop>
<diffle-stop path="shortlink/ratelimit.py" line="36">The wait is the missing fraction of a token over the rate.</diffle-stop>
<diffle-stop path="shortlink/app.py" line="26">The header carries the wait in whole seconds.</diffle-stop>
</diffle-trace>
<diffle-callout kind="danger"><p>The caller sets <code>x-forwarded-for</code>. A new value on every request gets a new bucket, so the limit never applies.</p></diffle-callout>
<p><code>int()</code> rounds the wait down:</p>
<diffle-tabs>
<diffle-tab title="Rounded down" kind="chosen"><p>A wait of 0.5 seconds sends <code>Retry-After: 0</code>, and the client retries at once.</p>
<diffle-diff path="shortlink/app.py" lines="26"></diffle-diff></diffle-tab>
<diffle-tab title="Rounded up" kind="example"><diffle-code lang="python" example>headers={"retry-after": str(math.ceil(retry))},</diffle-code></diffle-tab>
<diffle-tab title="The response" kind="example"><diffle-code lang="json" example title="429 Too Many Requests">{ "error": "slow down" }</diffle-code></diffle-tab>
</diffle-tabs>

<h2>Also in this change</h2>
<details><summary>A stats route and a stricter address check</summary>
<p><diffle-jump path="shortlink/app.py" line="40">GET /{code}/stats</diffle-jump> returns a link's hits, and <diffle-symbol path="shortlink/store.py" line="19" name="shorten"></diffle-symbol> refuses anything but a web address:</p>
<diffle-diff path="shortlink/store.py" lines="19-22"></diffle-diff>
</details>
<p>Before this merges:</p>
<diffle-check>
<diffle-item context="Behind a proxy that sets no header, every request shares one address.">Should the limiter trust <code>x-forwarded-for</code>?</diffle-item>
<diffle-item>Should <code>Retry-After</code> round up?</diffle-item>
<diffle-item context="A bucket is never removed once its client stops calling.">Is a map of buckets that only grows acceptable?</diffle-item>
</diffle-check>
`;
