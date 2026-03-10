# New Chat Client Specification

## Overview

A mobile-first chat client for interacting with the nostr-dm-bot. Text-based by default with optional rich UI components that enhance without bloating the screen.

## Design Principles

1. **Mobile-first**: Minimal screen real estate, touch-friendly
2. **Text-first, UI-enhanced**: Same commands work as text; clients render richer when capable
3. **Consistent patterns**: Same interaction model across all features
4. **Offline-capable**: Core features work without UI enhancements

## Command Palette

### Trigger

- `/` icon in input bar opens command palette
- Supports immediate filtering: type `/job` to filter

### Layout

```
[/] Search commands...
─────────────────────────────────
⭐ Recent (weighted by recency)
  /job list
  /todo add
─────────────────────────────────
Favorites ★ (per-bot or global)
  /git status
─────────────────────────────────
All Commands
  > job...
  > todo...
  > git...
```

### Interactions

- **Click** top-level → shows sub-commands
- **Click** leaf command → executes or opens UI
- **Fav star** → prompt: "Add to favorites for this bot? Or globally?"
- **Search** filters in real-time across all commands

### Mobile Adaptations

- Long-press command for quick actions
- Consider swipe gestures for favorites
- Search-first (vs deep hierarchy) works better on mobile

## Command Execution Modes

### Direct

Runs immediately, returns text output.

### Form

Needs user input. Client renders form based on command manifest.

```typescript
{
  command: 'job create',
  inputMode: 'form',
  ui: {
    fields: [
      { name: 'title', type: 'text', label: 'Job Title', required: true },
      { name: 'company', type: 'text', label: 'Company', required: true },
      { name: 'url', type: 'url', label: 'Link' },
      { name: 'salary', type: 'text', label: 'Salary range' },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ],
    submitLabel: 'Create Job'
  }
}
```

**Mobile**: Full-screen modal with scroll, fixed bottom submit bar.

### Preview

Shows data first, action buttons below.

```typescript
{
  type: 'preview',
  content: 'Job: Senior Engineer @ Acme\nSalary: $150k',
  actions: [
    { label: 'Apply', command: '/job apply {id}' },
    { label: 'Edit', command: '/job edit {id}' },
    { label: 'Delete', command: '/job delete {id}' }
  ]
}
```

**Mobile**: Collapsible card with sticky action bar at bottom.

## UI Components

### actionButton

Tap → sends command back to bot

```typescript
{
  type: 'actionButton',
  label: 'Mark Done',
  command: '/todo done {id}'
}
```

### expandable

Collapsed text with "show more" tap

```typescript
{
  type: 'expandable',
  summary: '3 new jobs found',
  details: '...full list...'
}
```

### statusCard

Summary line + actions

```typescript
{
  type: 'statusCard',
  title: 'Jobs',
  summary: '12 active, 3 new today',
  actions: [...]
}
```

### list

Compact rows with tap actions

```typescript
{
  type: 'list',
  items: [
    { label: 'Senior Engineer', subtitle: 'Acme', action: '/job view 1' },
    { label: 'Designer', subtitle: 'Beta', action: '/job view 2' }
  ]
}
```

## Data Flow

```
User Input → Command Parser → Bot Handler → Structured Response
                                              ↓
                                    { toText(), toUI() }
                                              ↓
                        Terminal Client    Mobile Client
                        (text render)     (UI components)
```

**Key principle**: Bot returns structured data, not UI. Client chooses how to render.

## Offline Support

- Core text commands work offline
- UI components gracefully degrade to text
- Favorites/recent cached locally
- Sync when online

## Future Considerations

- Voice input → command mapping
- Rich notifications with inline actions
- Widget support for system UIs
