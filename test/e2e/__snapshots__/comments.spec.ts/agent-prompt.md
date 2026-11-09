tally/currency.py:7

> _SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥"}

`KWD` gets three decimals above but no symbol here.

(agent) Added `KD` to `_SYMBOLS`.

---

(file) tally/refunds.py

(agent) Consider folding this into `ledger.py`; it only has two callers.

Agreed, in a follow-up.

---
