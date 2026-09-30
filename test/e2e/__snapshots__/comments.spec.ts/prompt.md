tally/currency.py:7

> _SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥"}

`KWD` gets three decimals above but no symbol here.

---

(file) tally/refunds.py

Consider folding this into `ledger.py`; it only has two callers.

---
