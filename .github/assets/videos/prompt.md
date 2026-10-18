shortlink/app.py:19-20

>     forwarded = request.headers.get("x-forwarded-for")
>     client = forwarded or request.client.host

`x-forwarded-for` is client-controlled, so a new value per request dodges the limit. Only trust it behind our proxy.

---

shortlink/ratelimit.py:24

>         now = time.time()

Use `time.monotonic()`: a wall-clock jump would refill or drain every bucket.

---
