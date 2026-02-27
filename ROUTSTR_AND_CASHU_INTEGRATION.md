Good catch. Let me check what models Routstr actually exposes and how opencode handles custom OpenAI-compatible providers.Good, now I have the full picture. Here's the revised plan:

---

# Revised Development Plan: Cashu Wallet + Routstr for nostr-dm-agent

## Key Design Clarifications

**The `X-Cashu` stateless approach is the right one**, but it has a fundamental mismatch with how opencode works: opencode is a subprocess that makes many API calls internally. You can't intercept each call to inject a fresh cashu token and recover change. The resolution is:

> The bot's provider layer wraps each **full opencode run** as one budget unit using the `Authorization: Bearer <cashu_token>` approach (which Routstr also supports and is functionally equivalent to a deposited session). Routstr internally treats the token as a prepaid balance and deducts per-request. After the run, `POST /v1/balance/refund` returns the change as a new Cashu token. The `X-Cashu` stateless header approach is reserved for direct single API calls the bot makes itself (e.g. `!ask` style commands in the future, not opencode runs).

**opencode.json provider config** is the right place to register Routstr as a model source. The bot generates or patches this file with the correct `apiKey` (the cashu token) before each run, since the key changes per run.

---

## File Structure

```
src/
  backends/           (unchanged — opencode.ts, cursor.ts, factory.ts)
  providers/
    types.ts          ← new
    routstr.ts        ← new
    local.ts          ← new (passthrough, current behaviour)
    factory.ts        ← new
  wallets/
    types.ts          ← new
    cashu.ts          ← new (adapted from your standalone script)
    factory.ts        ← new
  wallet-db.ts        ← new (separate SQLite, cashu-specific)
  db.ts               (unchanged)
  env.ts              (small additions)
  commands.ts         (new !wallet and !provider commands)
  index.ts            (small wiring change)
```

---

## Phase 1: Wallet Abstraction (`src/wallets/`)

### `src/wallets/types.ts`

```typescript
export type WalletInfo = {
  balanceSats: number;
};

export type AnyWallet = {
  name: string;
  getInfo(): Promise<WalletInfo>;
  // Deducts amountSats from stored proofs, returns an encoded token string.
  // Throws InsufficientFundsError if balance is too low.
  sendToken(amountSats: number): Promise<string>;
  // Receives a token (refund/change) back into stored proofs.
  receiveToken(encodedToken: string): Promise<{ receivedSats: number }>;
};

export class InsufficientFundsError extends Error {
  constructor(public available: number, public required: number) {
    super(`Insufficient funds: have ${available} sats, need ${required} sats`);
  }
}
```

### `src/wallets/cashu.ts`

Functional adaptation of your existing wallet script:

```typescript
export type CreateCashuWalletProps = {
  mnemonic: string;
  mintUrl: string;
};

export function createCashuWallet({ mnemonic, mintUrl }: CreateCashuWalletProps): AnyWallet {
  const db = openWalletDb(mnemonic);  // from wallet-db.ts

  return {
    name: 'cashu',

    async getInfo() {
      const proofs = loadProofs(db);
      return { balanceSats: totalBalance(proofs) };
    },

    async sendToken(amountSats) {
      const proofs = loadProofs(db);
      if (totalBalance(proofs) < amountSats) {
        throw new InsufficientFundsError(totalBalance(proofs), amountSats);
      }
      const wallet = await makeWallet(mnemonic, mintUrl, db);
      const { keep, send } = await wallet.ops.send(amountSats, proofs).asDeterministic().run();
      deleteProofs(db, proofs);
      if (keep.length > 0) saveProofs(db, keep);
      return getEncodedTokenV4({ mint: mintUrl, proofs: send, unit: 'sat' });
    },

    async receiveToken(encodedToken) {
      const wallet = await makeWallet(mnemonic, mintUrl, db);
      const newProofs = await wallet.ops.receive(encodedToken).asDeterministic().run();
      saveProofs(db, newProofs);
      return { receivedSats: totalBalance(newProofs) };
    },
  };
}
```

### `src/wallet-db.ts`

Separate SQLite at `~/.cashu-wallet/<fingerprint>.db`. Tables: `proofs`, `counters`, `spend_log`. All the proof/counter helper functions from your script live here. Completely isolated from `src/db.ts`.

```sql
CREATE TABLE spend_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  provider      TEXT NOT NULL,
  budget_sats   INTEGER NOT NULL,
  refund_sats   INTEGER NOT NULL DEFAULT 0,
  spent_sats    INTEGER NOT NULL,
  model         TEXT,
  session_id    TEXT,
  prompt_prefix TEXT
);
```

### `src/wallets/factory.ts`

```typescript
export type WalletName = 'cashu';

export function createWallet(name: WalletName, config: WalletConfig): AnyWallet
```

---

## Phase 2: Provider Abstraction (`src/providers/`)

The provider is responsible for: preparing env vars for the backend subprocess, handling the payment lifecycle around each run, and recovering change.

### `src/providers/types.ts`

```typescript
// Env vars the provider injects into the backend subprocess
export type ProviderEnv = Record<string, string>;

export type PrepareRunOptions = {
  budgetSats?: number;
};

export type FinalizeRunOptions = {
  success: boolean;
  sessionId?: string;
  promptPrefix?: string;
  model?: string;
};

export type AnyProvider = {
  name: string;
  // Called before each backend run. May mint a token, write opencode config, etc.
  prepareRun(opts: PrepareRunOptions): Promise<ProviderEnv>;
  // Called after each backend run (in a finally block). Handles change/refund.
  finalizeRun(env: ProviderEnv, opts: FinalizeRunOptions): Promise<void>;
  // Human-readable status for !provider status command
  getStatus(): Promise<string>;
};
```

### `src/providers/local.ts`

Passthrough for current behaviour. `prepareRun` returns empty env (process env already has OPENAI_API_KEY etc). `finalizeRun` is a no-op. This is the default when `CASHU_MNEMONIC` is not set.

### `src/providers/routstr.ts`

```typescript
export type CreateRoutstrProviderProps = {
  wallet: AnyWallet;
  baseUrl: string;
  walletDb: Database;   // for spend_log writes
};

export function createRoutstrProvider(props: CreateRoutstrProviderProps): AnyProvider {
  return {
    name: 'routstr',

    async prepareRun({ budgetSats = 2000 }) {
      const { balanceSats } = await props.wallet.getInfo();

      if (balanceSats < budgetSats) {
        throw new InsufficientFundsError(balanceSats, budgetSats);
      }

      const token = await props.wallet.sendToken(budgetSats);

      // The raw cashu token is the API key for Routstr
      return {
        ROUTSTR_TOKEN: token,         // stash for finalizeRun
        ROUTSTR_BUDGET: String(budgetSats),
      };
    },

    async finalizeRun(env, { success, sessionId, promptPrefix, model }) {
      const token = env.ROUTSTR_TOKEN;
      const budgetSats = Number(env.ROUTSTR_BUDGET);
      let refundSats = 0;

      try {
        const res = await fetch(`${props.baseUrl}/balance/refund`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.status === 402) {
          // Token fully exhausted — normal outcome, nothing to refund
          log.info('Routstr: token fully consumed, no change to recover');
        } else if (res.ok) {
          const data = await res.json();
          const refundToken: string = data.token ?? data.cashu_token ?? data.cashu;

          if (refundToken) {
            const { receivedSats } = await props.wallet.receiveToken(refundToken);
            refundSats = receivedSats;
            log.ok(`Routstr: recovered ${refundSats} sats change`);
          }
        } else {
          log.warn(`Routstr: refund returned HTTP ${res.status}`);
        }
      } catch (e) {
        log.warn(`Routstr: refund failed — ${e}. Unspent sats may be lost.`);
      }

      // Write spend log
      const spentSats = Math.max(0, budgetSats - refundSats);
      props.walletDb.run(
        `INSERT INTO spend_log (ts, provider, budget_sats, refund_sats, spent_sats, model, session_id, prompt_prefix)
         VALUES ($ts, 'routstr', $budget, $refund, $spent, $model, $session, $prompt)`,
        {
          $ts: Date.now(),
          $budget: budgetSats,
          $refund: refundSats,
          $spent: spentSats,
          $model: model ?? null,
          $session: sessionId ?? null,
          $prompt: promptPrefix?.slice(0, 80) ?? null,
        }
      );
    },

    async getStatus() {
      const { balanceSats } = await props.wallet.getInfo();
      return `routstr | wallet: ${balanceSats} sats | base: ${props.baseUrl}`;
    },
  };
}
```

**On 402 handling:** The 402 error body has shape `{ "error": { "type": "insufficient_balance", "code": "payment_required", "details": { "required": 154, "available": 100 } } }`. This can occur both mid-run (opencode gets a 402 back from Routstr, surfaces it as an API error in its output — the bot detects this in the final output string) and in `finalizeRun` (token already spent, 402 means no refund due — treated as normal).

### `src/providers/factory.ts`

```typescript
export type ProviderName = 'local' | 'routstr';

export function createProvider(name: ProviderName, deps: {
  wallet?: AnyWallet;
  walletDb?: Database;
  routstrBaseUrl?: string;
}): AnyProvider
```

---

## Phase 3: opencode.json Routstr Provider Config

This is the key integration point. To make opencode route its API calls through Routstr, you register it as a custom `@ai-sdk/openai-compatible` provider in `opencode.json`, and the `apiKey` is set dynamically via an env var that the bot injects per-run.

### Static part (committed to repo as `.opencode/opencode.json` or the project root `opencode.json`)

The bot generates/merges this block into the opencode config. The models list is fetched once from `GET /v1/models` and cached. A `!provider sync-models` command can refresh it.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "routstr": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Routstr (Cashu)",
      "options": {
        "baseURL": "https://api.routstr.com/v1",
        "apiKey": "{env:ROUTSTR_API_KEY}"
      },
      "models": {
        "gpt-4o": {
          "name": "GPT-4o (Routstr)",
          "limit": { "context": 128000, "output": 16384 }
        },
        "gpt-4o-mini": {
          "name": "GPT-4o Mini (Routstr)",
          "limit": { "context": 128000, "output": 16384 }
        },
        "claude-sonnet-4-20250514": {
          "name": "Claude Sonnet 4 (Routstr)",
          "limit": { "context": 200000, "output": 64000 }
        }
        // ... more models from /v1/models at sync time
      }
    }
  }
}
```

### Dynamic part — per-run env injection

`prepareRun` returns `{ ROUTSTR_API_KEY: cashuToken, ROUTSTR_TOKEN: cashuToken, ROUTSTR_BUDGET: '2000' }`. The backend merges this into the subprocess env. opencode reads `{env:ROUTSTR_API_KEY}` from the config and uses the fresh cashu token as the API key for that session. No need to rewrite the JSON file on every run — the env var approach handles it cleanly.

### `src/providers/routstr-models.ts` — model sync helper

```typescript
export type RoutstrModel = {
  id: string;
  name?: string;
  context_length?: number;
};

// Fetch available models from Routstr (no auth needed for /v1/models)
export async function fetchRoutstrModels(baseUrl: string): Promise<RoutstrModel[]> {
  const res = await fetch(`${baseUrl}/models`);
  if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);
  const data = await res.json();
  return data.data ?? data.models ?? [];
}

// Generate the opencode.json provider block for routstr
export function buildRoutstrProviderConfig(models: RoutstrModel[]): object {
  const modelEntries = Object.fromEntries(
    models.map((m) => [
      m.id,
      {
        name: `${m.id} (Routstr)`,
        ...(m.context_length ? { limit: { context: m.context_length, output: 16384 } } : {}),
      },
    ])
  );

  return {
    routstr: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Routstr (Cashu)',
      options: {
        baseURL: 'https://api.routstr.com/v1',
        apiKey: '{env:ROUTSTR_API_KEY}',
      },
      models: modelEntries,
    },
  };
}

// Merge routstr block into existing opencode.json without clobbering other providers
export function patchOpencodeConfig(configPath: string, routstrBlock: object): void { ... }
```

---

## Phase 4: Wiring into `index.ts`

The change to `handleUserMessage` is minimal. Before calling `runAgentRound`, the provider prepares env; after, it finalizes (in `finally`):

```typescript
// In handleUserMessage, wrap the runAgentRound calls:

const budgetSats = getRoutstrBudget(seenDb);  // from DB setting
let providerEnv: ProviderEnv = {};

try {
  providerEnv = await provider.prepareRun({ budgetSats });
} catch (e) {
  if (e instanceof InsufficientFundsError) {
    await sendReplyForSource(source, `Wallet balance too low. Have ${e.available} sats, need ${e.required} sats. Top up with: !wallet receive <cashuXXX>`);
    return;
  }
  throw e;
}

const runEnv = { ...agentEnv, ...providerEnv };

try {
  const result = await runAgentRound(content, ..., runEnv);
  // ... existing chunk/send logic
  await provider.finalizeRun(providerEnv, { success: true, sessionId, promptPrefix: content, model: modelName });
} catch (err) {
  await provider.finalizeRun(providerEnv, { success: false, sessionId });
  throw err;
}
```

---

## Phase 5: DB Settings

Add to `src/db.ts` (bot's existing seenDb):

- `provider_name` — `'local'` | `'routstr'`, default `'local'`
- `routstr_budget_sats` — integer, default `2000`
- `routstr_base_url` — text, default `'https://api.routstr.com/v1'`

Getter/setter helpers follow the existing pattern used for `getDefaultMode`, `getAgentBackend`, etc.

---

## Phase 6: Bang Commands

Remove `!provider model` (handled by opencode.json agent config). Add:

| Command | Description |
|---|---|
| `!wallet balance` | Show local Cashu balance in sats |
| `!wallet receive <cashuXXX>` | Manually top-up wallet |
| `!wallet history` | Last 10 entries from spend_log |
| `!provider set routstr` | Switch to Routstr (requires `CASHU_MNEMONIC`) |
| `!provider set local` | Switch back to local provider |
| `!provider budget <sats>` | Set per-run spending cap |
| `!provider status` | Show provider name, balance, base URL |
| `!provider sync-models` | Fetch `/v1/models` and patch opencode.json |

---

## Phase 7: Environment & Config

### `.env` additions
```
CASHU_MNEMONIC="word1 word2 ..."
CASHU_MINT_URL="https://mint.minibits.cash/Bitcoin"   # or your preferred mainnet mint
ROUTSTR_BASE_URL="https://api.routstr.com/v1"
```

### `src/env.ts` additions
```typescript
cashuMnemonic: process.env.CASHU_MNEMONIC ?? null,
cashuMintUrl:  process.env.CASHU_MINT_URL ?? 'https://testnut.cashu.space',
routstrBaseUrl: process.env.ROUTSTR_BASE_URL ?? 'https://api.routstr.com/v1',
```

Wallet is only instantiated if `CASHU_MNEMONIC` is set. If `provider_name` is `'routstr'` but `CASHU_MNEMONIC` is missing, the bot logs a warning at startup and falls back to `'local'`. Wallet balance appears in the startup status lines.

---

## Implementation Order

1. **`src/wallets/types.ts` + `src/wallet-db.ts` + `src/wallets/cashu.ts`** — pure refactor of your existing wallet script, zero external dependencies
2. **`src/providers/types.ts` + `src/providers/local.ts` + `src/providers/factory.ts`** — skeleton; local is a no-op passthrough
3. **Refactor `index.ts`** to call `provider.prepareRun`/`finalizeRun` using the local passthrough — behaviour is identical but the seam is in place
4. **`src/providers/routstr-models.ts`** — model fetching and opencode.json patching (testable independently with a `curl` to `/v1/models`)
5. **`src/providers/routstr.ts`** — implement with real Routstr testing; verify the refund endpoint shape before coding the response parsing
6. **DB settings** — `getRoutstrBudget`, `getProviderName`, setters
7. **`!wallet` and `!provider` bang commands**
8. **Spend log writes** in `finalizeRun` and `!wallet history` reader

---

## Open Question Before Coding

The one thing to verify manually before Phase 5: does `POST /v1/balance/refund` with `Authorization: Bearer <cashu_token>` (using the raw token, not a `sk-...` key) work, and what exact JSON key does it return the change token under? The docs show `sk-7f8e9d...` as the Bearer token for the refund call, while the homepage shows sending the raw `cashuA1...` token directly as the Bearer value. These two patterns may behave differently. Run a quick `curl` test against `api.routstr.com` with a small real token to confirm the exact refund flow before writing the `finalizeRun` implementation.