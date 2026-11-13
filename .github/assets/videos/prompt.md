tests/test_ratelimit.py:23-24

>     now[0] += 0.5
>     assert limiter.allow("a")

Why 0.5 s? Is that just enough for the next call to pass?

(agent) Yes: at `rate=2.0` one token takes 0.5 s to refill, so this is the shortest wait that lets the next call through.

---
