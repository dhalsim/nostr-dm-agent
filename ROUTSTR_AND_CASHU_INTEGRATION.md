# Final Revised Plan

## Key Facts from Docs + Code

**Routstr API:**
- Create session: `GET /v1/balance/create?initial_balance_token=cashuA...` → returns `api_key` (sk-...)
- Top up existing key: `POST /v1/balance/topup` with `{"cashu_token": "..."}` and `Authorization: Bearer sk-...`
- Refund: `POST /v1/balance/refund` with `Authorization: Bearer sk-...` → returns `{ token: "cashu...", msats: "450000" }`
- Refund response key is confirmed as `token`

**env var mechanism (from opencode.ts):**
```typescript
const proc = spawn({ cmd: args, cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env });
```
The `env` object is passed **directly to the subprocess**. If the bot puts `OPENAI_API_KEY: skKey` in that env object, and `opencode.json` has `"apiKey": "{env:OPENAI_API_KEY}"`, opencode resolves it from its own process env. This is the confirmed wiring path.

---

## Auto-flow (`!!sats`) — Corrected Logic

```
user: "fix the auth bug !!1000sats"

1. Parse → prompt = "fix the auth bug", budgetSats = 1000
2. Check DB for sk-key:
   - No sk-key:  mint 1000-sat cashu token
                 GET /v1/balance/create?initial_balance_token=<token>
                 store returned sk-key in DB (permanently)
   - sk-key exists: mint 1000-sat cashu token
                    POST /v1/balance/topup { cashu_token } + Bearer sk-key
                    (sk-key unchanged — same key, more balance)
3. Run opencode with env: { OPENAI_API_KEY: skKey, OPENAI_BASE_URL: ... }
4. After run (always, in finally):
   POST /v1/balance/refund → receive cashu token → swap into local wallet
   (do NOT clear sk-key)
```

**Manual flow** (`!provider deposit`/`!provider refund`) is the same operations just user-triggered, not prompt-triggered.

---

## Changes File by File

### `src/db.ts` — add three keys

```typescript
export const STATE_ROUTSTR_SK_KEY = 'routstr_sk_key';
export const STATE_ROUTSTR_MINT_URL = 'routstr_mint_url';
export const STATE_ROUTSTR_MODEL = 'routstr_model';
export const STATE_ROUTSTR_MODELS_CACHE = 'routstr_models_cache';
export const STATE_ROUTSTR_MODELS_CACHE_TS = 'routstr_models_cache_ts';

// sk-key: never auto-cleared, only set via deposit or !provider clear-session (future)
export function getRoutstrSkKey(db: Database): string | null
export function setRoutstrSkKey(db: Database, key: string): void

// mint: required for all wallet ops. no default.
export function getRoutstrMintUrl(db: Database): string | null
export function setRoutstrMintUrl(db: Database, url: string): void

// routstr model override: stored as bare model id, used as "routstr/<id>" in opencode
export function getRoutstrModel(db: Database): string | null
export function setRoutstrModel(db: Database, model: string | null): void

// model cache: 24h TTL stored in state table
export function getCachedRoutstrModels(db: Database): RoutstrModel[] | null {
  const ts = Number(getState(db, STATE_ROUTSTR_MODELS_CACHE_TS) ?? '0');
  if (Date.now() - ts > 86_400_000) return null;
  const raw = getState(db, STATE_ROUTSTR_MODELS_CACHE);
  return raw ? (JSON.parse(raw) as RoutstrModel[]) : null;
}
export function setCachedRoutstrModels(db: Database, models: RoutstrModel[]): void {
  setState(db, STATE_ROUTSTR_MODELS_CACHE, JSON.stringify(models));
  setState(db, STATE_ROUTSTR_MODELS_CACHE_TS, String(Date.now()));
}
```

---

### `src/providers/routstr.ts` — rewrite

Three distinct exported concerns: the provider object (used during runs), and standalone functions for deposit/topup, refund, balance check (used by commands and auto-flow).

```typescript
// --- Provider object (reads stored sk-key, injects into env) ---

export function createRoutstrProvider(props: {
  baseUrl: string;
  walletDb: Database;
  seenDb: Database;
}): AnyProvider {
  return {
    name: 'routstr',

    async prepareRun(_opts): Promise<ProviderEnv> {
      const skKey = getRoutstrSkKey(props.seenDb);
      if (!skKey) throw new NoRoutstrSessionError();
      return {
        OPENAI_API_KEY: skKey,
        OPENAI_BASE_URL: props.baseUrl,
      };
    },

    async finalizeRun(_env, opts): Promise<void> {
      // Spend logging only — refund is handled outside (auto-flow or manual)
      logSpend(props.walletDb, 'routstr', 0, 0, 0, opts.model, opts.sessionId, opts.promptPrefix);
    },

    async getStatus(): Promise<string> {
      const skKey = getRoutstrSkKey(props.seenDb);
      return `routstr | session: ${skKey ? skKey.slice(0, 16) + '...' : 'none (use !provider deposit <sats>)'}`;
    },
  };
}

export class NoRoutstrSessionError extends Error {
  constructor() {
    super('No Routstr session key. Use !provider deposit <sats> or append !!<sats> to your prompt.');
  }
}

// --- Create session OR top up existing one ---
// Handles both cases: no sk-key (create) and existing sk-key (topup)

export async function depositOrTopup(props: {
  wallet: AnyWallet;
  seenDb: Database;
  walletDb: Database;
  baseUrl: string;
  amountSats: number;
}): Promise<{ skKey: string; wasNew: boolean }> {
  const { wallet, seenDb, walletDb, baseUrl, amountSats } = props;

  const token = await wallet.sendToken(amountSats);

  const existingKey = getRoutstrSkKey(seenDb);

  let skKey: string;
  let wasNew: boolean;

  try {
    if (!existingKey) {
      // Create new session
      const res = await fetch(
        `${baseUrl}/balance/create?initial_balance_token=${encodeURIComponent(token)}`
      );
      if (!res.ok) throw new Error(`Create session failed: HTTP ${res.status}`);
      const data = await res.json() as { api_key?: string; key?: string };
      skKey = data.api_key ?? data.key ?? '';
      if (!skKey) throw new Error(`Unexpected create response: ${JSON.stringify(data)}`);
      setRoutstrSkKey(seenDb, skKey);
      wasNew = true;
    } else {
      // Top up existing session
      const res = await fetch(`${baseUrl}/balance/topup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${existingKey}`,
        },
        body: JSON.stringify({ cashu_token: token }),
      });
      if (!res.ok) throw new Error(`Top-up failed: HTTP ${res.status}`);
      skKey = existingKey;
      wasNew = false;
    }
  } catch (err) {
    // Return token to wallet on failure
    try { await wallet.receiveToken(token); } catch { /* best effort */ }
    throw err;
  }

  logSpend(walletDb, 'routstr', amountSats, 0, amountSats, undefined, undefined,
    wasNew ? 'create-session' : 'topup');
  return { skKey, wasNew };
}

// --- Refund (does NOT clear sk-key) ---

export async function refundRoutstr(props: {
  wallet: AnyWallet;
  seenDb: Database;
  walletDb: Database;
  baseUrl: string;
}): Promise<number> {
  const { wallet, seenDb, walletDb, baseUrl } = props;
  const skKey = getRoutstrSkKey(seenDb);
  if (!skKey) throw new Error('No Routstr session to refund.');

  const res = await fetch(`${baseUrl}/balance/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${skKey}` },
  });

  if (res.status === 402) {
    logSpend(walletDb, 'routstr', 0, 0, 0, undefined, undefined, 'refund-empty');
    return 0; // fully spent, nothing to refund — normal
  }
  if (!res.ok) throw new Error(`Refund failed: HTTP ${res.status}`);

  const data = await res.json() as { token?: string };
  if (!data.token) throw new Error(`Unexpected refund response: ${JSON.stringify(data)}`);

  const { receivedSats } = await wallet.receiveToken(data.token);
  logSpend(walletDb, 'routstr', 0, receivedSats, 0, undefined, undefined, 'refund');
  return receivedSats;
  // NOTE: sk-key intentionally NOT cleared
}

// --- Balance check ---

export async function getRoutstrBalance(seenDb: Database, baseUrl: string): Promise<number> {
  const skKey = getRoutstrSkKey(seenDb);
  if (!skKey) throw new Error('No Routstr session key. Use !provider deposit <sats> first.');
  const res = await fetch(`${baseUrl}/balance`, {
    headers: { Authorization: `Bearer ${skKey}` },
  });
  if (!res.ok) throw new Error(`Balance check failed: HTTP ${res.status}`);
  const data = await res.json() as { balance?: number; msats?: number };
  // Routstr returns msats; convert to sats
  const msats = data.msats ?? data.balance ?? 0;
  return Math.floor(Number(msats) / 1000);
}
```

---

### `src/providers/factory.ts` — remove wallet, add seenDb

The provider no longer needs `wallet` since all wallet operations happen outside of it (in auto-flow or commands directly):

```typescript
export type CreateProviderProps = {
  name: ProviderName;
  walletDb?: Database;
  seenDb?: Database;
  routstrBaseUrl?: string;
};

export function createProvider(props: CreateProviderProps): AnyProvider {
  if (props.name === 'routstr') {
    if (!props.walletDb || !props.seenDb || !props.routstrBaseUrl) {
      throw new Error('Routstr provider requires walletDb, seenDb, and routstrBaseUrl');
    }
    return createRoutstrProvider({
      baseUrl: props.routstrBaseUrl,
      walletDb: props.walletDb,
      seenDb: props.seenDb,
    });
  }
  return createLocalProvider();
}
```

---

### `src/wallets/factory.ts` — create this file (currently 404)

```typescript
import { createCashuWallet } from './cashu';
import type { AnyWallet } from './types';

export function createWallet(props: { mnemonic: string; mintUrl: string }): AnyWallet {
  return createCashuWallet(props);
}
```

---

### `src/budget-annotation.ts` — new file

```typescript
const ANNOTATION_RE = /\s*!!(\d+)(?:sats?)?\s*$/i;

export type ParsedPrompt = {
  prompt: string;
  budgetSats: number | null;
};

export function parseBudgetAnnotation(input: string): ParsedPrompt {
  const match = input.match(ANNOTATION_RE);
  if (!match) return { prompt: input.trim(), budgetSats: null };
  return {
    prompt: input.slice(0, input.length - match[0].length).trimEnd(),
    budgetSats: parseInt(match[1], 10),
  };
}
```

---

### `src/index.ts` — main wiring

**At startup (inside `main()`):**

```typescript
import { createCashuWallet } from './wallets/cashu';
import { openWalletDb } from './wallet-db';
import { createProvider } from './providers/factory';
import { parseBudgetAnnotation } from './budget-annotation';
import { depositOrTopup, refundRoutstr, NoRoutstrSessionError } from './providers/routstr';
import { InsufficientFundsError } from './wallets/types';
import {
  getProviderName, getRoutstrBudget, getRoutstrSkKey,
  getRoutstrMintUrl, getRoutstrModel,
} from './db';

// Mint comes from DB only — required for wallet ops
const mintUrl = (): string | null => getRoutstrMintUrl(seenDb); // called lazily

// Wallet — only created when mint is configured
function getWallet(): AnyWallet | null {
  const mint = mintUrl();
  if (!config.cashuMnemonic || !mint) return null;
  // Lazily constructed — could cache this if needed
  return createCashuWallet({ mnemonic: config.cashuMnemonic, mintUrl: mint });
}

const walletDb = config.cashuMnemonic ? openWalletDb(config.cashuMnemonic) : undefined;

// Provider: re-read from DB each call so !provider set takes effect without restart
function getActiveProvider(): AnyProvider {
  return createProvider({
    name: getProviderName(seenDb),
    walletDb,
    seenDb,
    routstrBaseUrl: config.routstrBaseUrl,
  });
}
```

**In `handleUserMessage`:**

```typescript
async function handleUserMessage(content: string, source: MessageSource): Promise<void> {
  // 1. Parse inline budget annotation
  const { prompt: effectiveContent, budgetSats: inlineBudget } = parseBudgetAnnotation(content);
  const isAutoFlow = inlineBudget !== null && getProviderName(seenDb) === 'routstr';

  // 2. Auto-flow: deposit/topup before run
  if (isAutoFlow) {
    const wallet = getWallet();
    if (!wallet || !walletDb) {
      await sendReplyForSource(source,
        'Wallet not available. Set CASHU_MNEMONIC and use !wallet mint <url> to configure.');
      return;
    }
    try {
      const { wasNew } = await depositOrTopup({
        wallet, seenDb, walletDb,
        baseUrl: config.routstrBaseUrl,
        amountSats: inlineBudget,
      });
      log(`Auto-flow: ${wasNew ? 'created session' : 'topped up'} with ${inlineBudget} sats`);
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        await sendReplyForSource(source,
          `Insufficient local balance: ${err.available} sats available, ${err.required} needed.\nTop up with: !wallet receive <token>`);
      } else {
        await sendReplyForSource(source, `Deposit failed: ${String(err)}`);
      }
      return;
    }
  }

  // 3. Build provider env (reads sk-key from DB)
  const provider = getActiveProvider();
  let providerEnv: ProviderEnv = {};
  try {
    providerEnv = await provider.prepareRun({ budgetSats: inlineBudget ?? getRoutstrBudget(seenDb) });
  } catch (err) {
    if (err instanceof NoRoutstrSessionError) {
      await sendReplyForSource(source, err.message);
      return;
    }
    throw err;
  }

  // 4. Merge provider env into subprocess env
  // providerEnv contains OPENAI_API_KEY=sk-... and OPENAI_BASE_URL=...
  // opencode reads these via {env:OPENAI_API_KEY} in opencode.json
  const runEnv = { ...agentEnv, ...providerEnv };

  // 5. Inject routstr model if set (opencode understands "routstr/model-id" syntax)
  const routstrModel = getRoutstrModel(seenDb);
  if (routstrModel && getProviderName(seenDb) === 'routstr') {
    runEnv['OPENCODE_MODEL'] = `routstr/${routstrModel}`;
    // OR pass as --model flag — see opencode.ts change below
  }

  let success = false;
  try {
    // ... existing runAgentRound / lint / chunk / send logic
    // key change: pass runEnv instead of agentEnv to runMessage
    success = true;
  } finally {
    // 6. Auto-flow: always refund after run (whether success or failure)
    if (isAutoFlow) {
      const wallet = getWallet();
      if (wallet && walletDb) {
        try {
          const recovered = await refundRoutstr({
            wallet, seenDb, walletDb, baseUrl: config.routstrBaseUrl,
          });
          if (recovered > 0) log(`Auto-flow: recovered ${recovered} sats`);
        } catch (err) {
          log(`Auto-flow refund failed: ${String(err)}`);
        }
      }
    }

    await provider.finalizeRun(providerEnv, {
      success,
      sessionId,
      promptPrefix: effectiveContent,
      model: backend.modelName,
    });
  }
}
```

---

### opencode.ts — model override for routstr

The model override currently comes from `parseModel()` which reads `modelOverride` prop or `opencode.json`. For routstr runs we need to pass `--model routstr/<id>`. Add to the `runMessage` args in `opencode.ts`:

```typescript
// In runMessage, after building args:
if (routstrModelOverride) {
  args.push('--model', routstrModelOverride);
}
```

But cleaner: pass it as part of `RunMessageProps`. Add optional `modelOverride` to `RunMessageProps` in `types.ts`:

```typescript
export type RunMessageProps = {
  sessionId: string;
  content: string;
  mode: AgentMode;
  cwd: string;
  env: Record<string, string | undefined>;
  modelOverride?: string;  // ← new, used for routstr/model-id
};
```

In `opencode.ts`'s `runMessage`, append `--model` flag if provided:
```typescript
if (runMode_props.modelOverride) {
  args.push('--model', runMode_props.modelOverride);
}
```

In `index.ts`, when building the round, pass:
```typescript
modelOverride: (getProviderName(seenDb) === 'routstr' && routstrModel)
  ? `routstr/${routstrModel}`
  : undefined,
```

---

### `src/commands.ts` — updated sections

**`!wallet` — mint required, history filtered by mint:**

```typescript
case 'wallet': {
  const subcmd = args[0]?.toLowerCase();

  // mint command doesn't need a wallet
  if (subcmd === 'mint') {
    const url = args[1];
    if (!url) {
      const current = getRoutstrMintUrl(db);
      return current
        ? `Current mint: ${current}`
        : 'No mint configured. Use: !wallet mint <url>';
    }
    setRoutstrMintUrl(db, url);
    return `Mint set to: ${url}`;
  }

  // All other wallet commands need mint + mnemonic
  const mint = getRoutstrMintUrl(db);
  if (!mint) return 'No mint configured. Set one with: !wallet mint <url>';
  if (!config.cashuMnemonic) return 'CASHU_MNEMONIC not set.';

  const wallet = createCashuWallet({ mnemonic: config.cashuMnemonic, mintUrl: mint });

  switch (subcmd) {
    case 'balance': {
      const { balanceSats } = await wallet.getInfo();
      return `Wallet balance: ${balanceSats} sats (mint: ${mint})`;
    }
    case 'receive': {
      const token = args[1];
      if (!token) return 'Usage: !wallet receive <cashu-token>';
      try {
        const { receivedSats } = await wallet.receiveToken(token);
        return `Received ${receivedSats} sats.`;
      } catch (err) {
        return `Failed to receive: ${String(err)}`;
      }
    }
    case 'history': {
      if (!walletDb) return 'Wallet DB not available.';
      const history = getRecentSpendHistory(walletDb, 10);
      if (history.length === 0) return 'No spend history yet.';
      return history.map((h) => {
        const date = new Date(h.ts).toISOString().slice(0, 16).replace('T', ' ');
        return `${date} | ${h.provider} | budget: ${h.budget_sats} | refund: ${h.refund_sats} | spent: ${h.spent_sats}`;
      }).join('\n');
    }
    default:
      return 'Usage: !wallet mint [url] | balance | receive <token> | history';
  }
}
```

**`!provider` — updated subcommands:**

```typescript
case 'provider': {
  switch (subcmd) {
    case 'set': {
      // validate + setProviderName as before
      if (parsed.data === 'routstr') {
        const mint = getRoutstrMintUrl(db);
        const skKey = getRoutstrSkKey(db);
        const lines = ['Provider set to: routstr'];
        if (!mint) lines.push('⚠ No mint set — use !wallet mint <url>');
        if (!config.cashuMnemonic) lines.push('⚠ CASHU_MNEMONIC not set');
        lines.push(skKey
          ? `Session key: ${skKey.slice(0, 16)}...`
          : 'No session yet. Use !provider deposit <sats> or append !!<sats> to your prompt.');
        return lines.join('\n');
      }
      return 'Provider set to: local';
    }

    case 'deposit': {
      const sats = parseInt(args[1], 10);
      if (isNaN(sats) || sats <= 0) return 'Usage: !provider deposit <sats>';

      const mint = getRoutstrMintUrl(db);
      if (!mint) return 'No mint configured. Use !wallet mint <url> first.';
      if (!config.cashuMnemonic) return 'CASHU_MNEMONIC not set.';
      if (!walletDb) return 'Wallet DB not available.';

      const wallet = createCashuWallet({ mnemonic: config.cashuMnemonic, mintUrl: mint });
      const { balanceSats } = await wallet.getInfo();
      if (balanceSats < sats) {
        return `Insufficient balance: ${balanceSats} sats available. Top up with !wallet receive <token>.`;
      }

      try {
        const { skKey, wasNew } = await depositOrTopup({
          wallet, seenDb: db, walletDb,
          baseUrl: routstrBaseUrl ?? config.routstrBaseUrl,
          amountSats: sats,
        });
        const action = wasNew ? 'Created new session' : 'Topped up existing session';
        setProviderName(db, 'routstr');
        return `${action} with ${sats} sats.\nSession: ${skKey.slice(0, 16)}...\nProvider set to routstr.`;
      } catch (err) {
        return `Deposit failed: ${String(err)}`;
      }
    }

    case 'refund': {
      const mint = getRoutstrMintUrl(db);
      if (!mint) return 'No mint configured.';
      if (!config.cashuMnemonic || !walletDb) return 'Wallet not configured.';

      const wallet = createCashuWallet({ mnemonic: config.cashuMnemonic, mintUrl: mint });
      try {
        const sats = await refundRoutstr({
          wallet, seenDb: db, walletDb,
          baseUrl: routstrBaseUrl ?? config.routstrBaseUrl,
        });
        return sats === 0
          ? 'Nothing to refund (session balance was 0).'
          : `Refunded ${sats} sats to local wallet. Session key kept for future use.`;
      } catch (err) {
        return `Refund failed: ${String(err)}`;
      }
    }

    case 'balance': {
      try {
        const sats = await getRoutstrBalance(db, routstrBaseUrl ?? config.routstrBaseUrl);
        return `Routstr session balance: ${sats} sats`;
      } catch (err) {
        return `Balance check failed: ${String(err)}`;
      }
    }

    case 'status': {
      const name = getProviderName(db);
      const skKey = getRoutstrSkKey(db);
      const mint = getRoutstrMintUrl(db);
      const model = getRoutstrModel(db);
      const budget = getRoutstrBudget(db);
      if (name !== 'routstr') return 'Provider: local | no payment';
      return [
        `Provider:       routstr`,
        `Session key:    ${skKey ? skKey.slice(0, 16) + '...' : 'none'}`,
        `Mint:           ${mint ?? 'not set (!wallet mint <url>)'}`,
        `Default budget: ${budget} sats`,
        `Model:          ${model ? `routstr/${model}` : 'backend default'}`,
      ].join('\n');
    }

    case 'sync-models': {
      // Refresh cache only — no file patching
      try {
        const models = await fetchRoutstrModels(routstrBaseUrl ?? config.routstrBaseUrl);
        setCachedRoutstrModels(db, models);
        return `Cached ${models.length} Routstr models.\nUse !models routstr [filter] to browse.`;
      } catch (err) {
        return `Failed to sync: ${String(err)}`;
      }
    }
  }
}
```

**`!models` — add routstr with filter:**

```typescript
case 'models': {
  const filterArg = args[0]?.toLowerCase();
  const searchArg = args[1]?.toLowerCase();

  if (filterArg === 'routstr') {
    const baseUrl = routstrBaseUrl ?? config.routstrBaseUrl;
    let models = getCachedRoutstrModels(db);

    if (!models) {
      // Auto-fetch and cache if not yet cached
      try {
        models = await fetchRoutstrModels(baseUrl);
        setCachedRoutstrModels(db, models);
      } catch (err) {
        return `Failed to fetch Routstr models: ${String(err)}`;
      }
    }

    const filtered = searchArg
      ? models.filter((m) => m.id.toLowerCase().includes(searchArg))
      : models;

    if (filtered.length === 0) {
      return searchArg
        ? `No Routstr models matching "${searchArg}". Try !provider sync-models if cache is stale.`
        : 'No Routstr models cached. Run !provider sync-models.';
    }

    const current = getRoutstrModel(db);
    const lines = filtered.map((m) =>
      m.id === current ? `* ${m.id}` : `  ${m.id}`
    );
    return `Routstr models${searchArg ? ` (filter: ${searchArg})` : ''}:\n${lines.join('\n')}`;
  }

  // Existing backend model listing (unchanged)
  // ...
}
```

**`!model` — support `routstr/<id>` prefix:**

```typescript
case 'model': {
  const selected = args[0];

  if (!selected) {
    const routstrModel = getRoutstrModel(db);
    const override = getModelOverride(db);
    const lines = [];
    if (routstrModel) lines.push(`Routstr model: routstr/${routstrModel}`);
    lines.push(`General override: ${override ?? 'none (using backend config)'}`);
    return lines.join('\n');
  }

  if (selected.toLowerCase() === 'reset') {
    setModelOverride(db, null);
    setRoutstrModel(db, null);
    return 'All model overrides cleared.';
  }

  if (selected.toLowerCase().startsWith('routstr/')) {
    const modelId = selected.slice('routstr/'.length);
    if (!modelId) return 'Usage: !model routstr/<model-id>';
    setRoutstrModel(db, modelId);
    return `Routstr model set to: routstr/${modelId}\nOpencode will use this model on Routstr runs.`;
  }

  setModelOverride(db, selected);
  return `Model override set to: ${selected}`;
}
```

---

### `opencode.json` — one-time manual setup

Document this as a one-time user step. The bot sets `OPENAI_API_KEY` via env; opencode.json reads it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "routstr": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Routstr",
      "options": {
        "baseURL": "https://api.routstr.com/v1",
        "apiKey": "{env:OPENAI_API_KEY}"
      },
      "models": {}
    }
  },
  "agent": {
    "ask":   { "model": "routstr/gpt-4o-mini" },
    "plan":  { "model": "routstr/gpt-4o-mini" },
    "agent": { "model": "routstr/gpt-4o-mini" }
  }
}
```

The `models: {}` is intentionally empty — opencode only needs the provider block for auth. After `!models routstr gemini` the user finds the model ID they want, then `!model routstr/that-model-id` sets it, and the bot passes `--model routstr/that-model-id` as a CLI flag, which overrides the config-file default.

---

### Updated `!help` text

```
!wallet mint [url]           — show/set default Cashu mint (required for wallet ops)
!wallet balance              — show local wallet balance
!wallet receive <token>      — receive a Cashu token into local wallet
!wallet history              — recent spend history

!provider set [local|routstr] — switch payment provider
!provider deposit <sats>      — fund/topup Routstr session from local wallet
!provider refund              — recover unspent Routstr balance to local wallet
!provider balance             — check remaining Routstr session balance (in sats)
!provider budget <sats>       — set default budget (used when no !!sats in prompt)
!provider status              — show provider, session, mint, model, budget
!provider sync-models         — refresh Routstr model cache (valid 24h)

!models routstr [filter]      — list Routstr models, optional text filter
!model routstr/<id>           — set model for Routstr runs
!model reset                  — clear all model overrides

Inline budget: append !!<sats> to any prompt for auto deposit+refund
  e.g. "fix the login bug !!2000sats"
```

---

## Files Summary

| File | Action | Key change |
|---|---|---|
| `src/db.ts` | edit | Add `sk_key`, `mint_url`, `routstr_model`, model cache helpers |
| `src/providers/routstr.ts` | rewrite | `depositOrTopup` (create vs topup), `refundRoutstr` (no sk clear), `getRoutstrBalance`; provider reads sk from DB |
| `src/providers/factory.ts` | edit | Remove `wallet`, add `seenDb` |
| `src/wallets/factory.ts` | **create** | Thin wrapper around `createCashuWallet` |
| `src/budget-annotation.ts` | **create** | `parseBudgetAnnotation` |
| `src/backends/types.ts` | edit | Add `modelOverride?: string` to `RunMessageProps` |
| `src/backends/opencode.ts` | edit | Pass `--model` flag when `modelOverride` is set |
| `src/commands.ts` | edit | `!wallet mint`, `!provider deposit/refund/balance/sync-models`, `!models routstr [filter]`, `!model routstr/...` |
| `src/index.ts` | edit | Instantiate wallet/walletDb, `getActiveProvider()`, `parseBudgetAnnotation`, auto-flow wrapping |
| `src/env.ts` | fix | `BOT_RELAYS` → `BOT_MASTER_PUBKEY` bug |
| `opencode.json` | manual doc | One-time provider block + agent model config |