tally/currency.py:7

> _SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥"}

`KWD` gets three decimals above but no symbol here.

(agent) Added `KD` to `_SYMBOLS`.

---

(file) tally/refunds.py

(agent) Consider folding this into `ledger.py`; it only has two callers.

Agreed, in a follow-up.

---

## Pending feedback in Diffle

Run `diffle comments context <target>` immediately before addressing each item. Verify the fix and send a short summary with `diffle comments reply <target> <summary>`. Leave blocked items pending.

`KWD` gets three decimals above but no symbol here.

Target: `[target]`

Original (New side) tally/currency.py:7–7
> 4:
> 5: # Minor units per currency; everything else has two.
> 6: _DIGITS = {"JPY": 0, "KWD": 3}
> 7: _SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£", "JPY": "¥"}
> 8:
> 9:
> 10: def minor_units(currency: str) -> int:

Agreed, in a follow-up.

Target: `[target]`
