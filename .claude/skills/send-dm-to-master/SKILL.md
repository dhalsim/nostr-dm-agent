---
name: send-dm-to-master
description: Send a DM to the master pubkey.
allowed-tools: Bash
---

## Send a DM to the master pubkey

When sending a DM to the master pubkey:
- Use the `send-dm-to-master` tool to send a DM to the master pubkey.
- The tool takes a single argument: the message to send.
- The message is sent to the master pubkey.

## CLI Interface

Call tools via bash with a single-quoted JSON argument:

```bash
bun src/scripts/send-dm-to-master.ts "<message>"
```
