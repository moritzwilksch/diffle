---
title: Remote and proxy setups
description: Run diffle on another machine, or behind a reverse proxy.
sidebar:
  order: 8
---

By default, diffle listens on `127.0.0.1:4966` (or the next free port) and only accepts requests
from the same machine.

## On another machine

To review on a remote host from your local browser, forward the port over SSH and open
`http://127.0.0.1:4966`:

```bash
ssh -L 4966:127.0.0.1:4966 devbox
diffle working --no-open --keep-alive
```

Or bind to the network:

```bash
diffle working -H 0.0.0.0 --no-open
```

With `-H`, diffle accepts the machine's IP addresses and host names. Anyone who can reach the port
can read the repository and edit comments, so prefer the SSH tunnel on shared networks.

`--keep-alive` keeps diffle running after the last tab closes. Without it, closing the tab stops
diffle and prints the [prompt](./agent-handoff.md).

## Behind a reverse proxy

diffle works under a path prefix such as `https://proxy.example/diffle/` with no extra setting.
Have the proxy strip the prefix, including for WebSocket upgrades at `/diffle/ws`, and trust its
public origin:

```bash
diffle working -H 0.0.0.0 --no-open --allowed-origin https://proxy.example
```

If the proxy rewrites `Host` and `Origin` to its upstream address, such as a Kubernetes service
name, trust that address instead. A rejected request gets a 403 that names the header that failed.
