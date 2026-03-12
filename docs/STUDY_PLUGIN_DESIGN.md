# Recall Trainer Plugin - Design Sketch

## Overview

Spaced repetition flashcard plugin. Users manage vocabulary study sets and practice via DM quiz sessions.

## Capability

```json
{
  "name": "study",
  "version": "1.0.0"
}
```

## Commands

| Command                        | Description               |
| ------------------------------ | ------------------------- |
| `!study create <name>`         | Create new study set      |
| `!study list`                  | List all study sets       |
| `!study set <id>`              | Switch active set         |
| `!study add <source> <target>` | Add vocab to active set   |
| `!study remove <id>`           | Remove vocab entry        |
| `!study due`                   | Show items due for review |
| `!study quiz`                  | Start quiz session        |
| `!study stats`                 | Show learning statistics  |
| `!study import <json>`         | Import study set (JSON)   |
| `!study export`                | Export active set as JSON |

## Quiz Flow

```
User: !study quiz
Bot:  [1] apple = ???
User:  apple
Bot:  ✓ Correct! Next: [2] dog = ???
User:  cat
Bot:  ✗ Wrong! Answer: dog

... (after 10 questions)

Bot:  Quiz complete! Score: 7/10
      !study quiz continue   - continue with more
      !study quiz review    - review mistakes
      !study stats          - view progress
```

## Data Model

### Per-User Storage

```typescript
interface StudyUserState {
  userId: string;
  activeSetId: string | null;
  sets: StudySet[];
  // Quiz session state
  quizSession: QuizSession | null;
}

interface StudySet {
  id: string;
  name: string;
  mainLanguage: string; // e.g., "en"
  targetLanguage: string; // e.g., "ja"
  entries: StudyEntry[];
}

interface StudyEntry {
  id: string;
  source: string;
  target: string;
  acceptedAnswers?: string[]; // alternative correct answers
  // Spaced repetition state
  sourceNextReview: number; // timestamp
  targetNextReview: number;
  sourceLevel: number; // 0-7 (Fibonacci)
  targetLevel: number;
  errorCount: number;
}

interface QuizSession {
  setId: string;
  direction: 'source_to_target' | 'target_to_source';
  queue: string[]; // entry IDs
  currentIndex: number;
  correct: number;
  incorrect: number;
  results: { entryId: string; userAnswer: string; correct: boolean }[];
}
```

## File Structure

```
plugins/study/
├── manifest.json
├── src/
│   ├── index.ts           # Plugin entry, register commands
│   ├── commands/
│   │   ├── study.ts       # Main !study handler
│   │   └── quiz.ts        # Quiz session logic
│   ├── db.ts              # User state storage
│   ├── types.ts           # TypeScript interfaces
│   ├── spaced-repetition.ts  # Fibonacci interval logic
│   └── format.ts          # Response formatting
└── README.md
```

## manifest.json

```json
{
  "name": "study",
  "version": "1.0.0",
  "description": "Spaced repetition flashcard plugin",
  "author": "community",
  "apiVersion": "1.0.0",
  "provides": [{ "name": "study", "version": "1.0.0" }],
  "requires": [{ "name": "storage", "version": ">=2.0.0" }],
  "commands": [
    { "name": "study create", "inputMode": "direct", "description": "Create study set" },
    { "name": "study add", "inputMode": "direct", "description": "Add vocabulary" },
    { "name": "study quiz", "inputMode": "direct", "description": "Start quiz" }
  ]
}
```

## Plugin skeleton

Minimal entry point implementing the plugin contract (see [PLUGIN_SYSTEM.md](./PLUGIN_SYSTEM.md)): register commands and wire to handlers.

```typescript
// plugins/study/src/index.ts
import type { Plugin, PluginContext, CommandSpec, CommandContext, CommandResult } from '../plugin-api';
import { handleStudyCommand } from './commands/study';
import { handleQuizCommand } from './commands/quiz';

let registeredCommands: CommandSpec[] = [];

export const studyPlugin: Plugin = {
  async init(ctx: PluginContext): Promise<void> {
    const storage = ctx.getCapability('storage');
    if (!storage) throw new Error('study plugin requires storage capability');

    const register = (name: string, description: string, handler: (ctx: CommandContext) => Promise<CommandResult>) => {
      const spec: CommandSpec = { name, inputMode: 'direct', description };
      ctx.registerCommand(spec);
      registeredCommands.push(spec);
      // Bot wires spec.name → handler when dispatching
    };

    register('study create', 'Create study set', (cmdCtx) => handleStudyCommand({ subcommand: 'create', ...cmdCtx }));
    register('study list', 'List all study sets', (cmdCtx) => handleStudyCommand({ subcommand: 'list', ...cmdCtx }));
    register('study set', 'Switch active set', (cmdCtx) => handleStudyCommand({ subcommand: 'set', ...cmdCtx }));
    register('study add', 'Add vocabulary', (cmdCtx) => handleStudyCommand({ subcommand: 'add', ...cmdCtx }));
    register('study remove', 'Remove vocab entry', (cmdCtx) => handleStudyCommand({ subcommand: 'remove', ...cmdCtx }));
    register('study due', 'Show items due for review', (cmdCtx) => handleStudyCommand({ subcommand: 'due', ...cmdCtx }));
    register('study quiz', 'Start quiz session', (cmdCtx) => handleQuizCommand(cmdCtx));
    register('study stats', 'Show learning statistics', (cmdCtx) => handleStudyCommand({ subcommand: 'stats', ...cmdCtx }));
    register('study import', 'Import study set (JSON)', (cmdCtx) => handleStudyCommand({ subcommand: 'import', ...cmdCtx }));
    register('study export', 'Export active set as JSON', (cmdCtx) => handleStudyCommand({ subcommand: 'export', ...cmdCtx }));
  },

  async shutdown(): Promise<void> {
    registeredCommands = [];
  },
};

export default studyPlugin;
```

- `PluginContext.registerCommand` registers a command with the bot; the bot later dispatches `!study ...` to the matching handler.
- Handlers receive `CommandContext` (e.g. `userId`, `args`, `raw`) and return `CommandResult` (`type: 'text' | 'error'`, `content`).
- Storage is obtained via `getCapability('storage')` and used in `commands/study.ts` and `commands/quiz.ts` for user state (see Data Model).

## Key Implementation Details

### Spaced Repetition (Fibonacci)

```typescript
const REVIEW_INTERVAL_DAYS = [0, 1, 1, 2, 3, 5, 8, 13];

function getNextReview(level: number): number {
  const days = REVIEW_INTERVAL_DAYS[Math.min(level, 7)];
  return Date.now() + days * 24 * 60 * 60 * 1000;
}
```

### Quiz Session State

- Stored per-user in bot's database
- Quiz session persists across messages (user can step away)
- Session timeout: 30 minutes of inactivity

### Answer Checking

- Case-insensitive match on target
- Fuzzy matching for typos (Levenshtein distance ≤ 2)
- Alternative answers supported

## Open Questions

1. **NIP-78 sync**: Reuse recall-trainer's sync? Or keep separate?
2. **Import format**: JSON only, or support CSV/Anki import?
3. **Quiz length**: Configurable? Default 10 questions?
4. **Multi-language**: Support more than en/ja/tr?
