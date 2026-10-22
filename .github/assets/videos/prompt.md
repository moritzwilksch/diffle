tests/test_ratelimit.py:23-24

>     now[0] += 0.5
>     assert limiter.allow("a")

Also step the clock back: a negative `elapsed` drains the bucket. `time.monotonic()` cannot go back.

---
