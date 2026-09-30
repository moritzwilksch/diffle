(stale, was line 26) tally/cli.py:27

> print("no entries", file=sys.stderr)

Exit code 1 for "nothing to do" will trip `set -e` in the cron wrapper.

---

tally/currency.py:7

> _SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥"}

`KWD` gets three decimals above but no symbol here.

ORIGINAL:
```
_SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥"}
```
SUGGESTED:
```
_SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥", "KWD": "KD"}
```

---

tally/ledger.py:3-4

> A line is a sale unless its ``kind`` column says ``refund``; refunds count negative.
> """

Say what counts as a refund here, not only in the parser.

Also link the release notes once they mention `kind`.

---

(removed) tally/legacy.py:9-15

> def read_tsv(path: Path) -> Ledger:
>     ledger = Ledger()
>     for line in path.read_text().splitlines():
>         if not line or line.startswith("#"):
>             continue
>         account, description, quantity, unit_price = line.split("\t")
>         ledger.add(Entry(account, description, int(quantity), Decimal(unit_price)))

Is the archive really converted? The cron job still calls this.

---

(file) tally/refunds.py

Consider folding this into `ledger.py`; it only has two callers.

---
