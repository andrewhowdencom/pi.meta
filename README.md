# pi.meta

A Pi extension that injects configurable context snippets into the agent's system prompt, providing the LLM with metadata about its execution environment — the harness, the active model, the provider, the working directory, and any additional context published by other extensions.

## Why?

Pi agents operate without inherent knowledge of their own runtime context. This extension closes that gap by automatically injecting structured metadata into every turn, so the agent knows:

- That it is running inside the Pi Harness
- Which model and provider are serving requests
- What the current thinking level is (if supported by the model)
- How many tokens have been spent in this session
- What the current working directory is
- What workflow or subagent state other extensions have published

All snippets are individually enable/disable-able, and third-party extensions can publish their own context dynamically.

## Installation

Copy `system-context.ts` into your Pi extensions directory:

```bash
# Project-local (recommended for per-project context)
cp system-context.ts /path/to/your/project/.pi/extensions/

# Global (applies to all projects)
cp system-context.ts ~/.pi/agent/extensions/
```

Then reload Pi with `/reload` or restart the session.

## Built-in Snippets

| ID | Label | Description | Default |
|---|---|---|---|
| `harness` | Pi Harness | Indicates the agent is running within the Pi Harness | **enabled** |
| `model` | Current Model | Shows the active LLM model (`provider/id`) | **enabled** |
| `provider` | Current Provider | Shows the active LLM provider | **enabled** |
| `thinking-level` | Thinking Level | Shows the active thinking/reasoning level | disabled |
| `token-spend` | Token Spend | Shows cumulative token usage and cost for this session | disabled |
| `cwd` | Working Directory | Shows the current working directory | disabled |
| `datetime` | Date and Time | Shows the current date and time in ISO 8601 format | disabled |

## User Commands

### `/system-context`

List all built-in and external snippets with their current enabled/disabled status.

### `/system-context toggle <id>`

Toggle a snippet on or off. Examples:

```
/system-context toggle cwd
/system-context toggle model
```

### `/system-context reset`

Reset all built-in snippets to their defaults and clear all external snippets.

## Injected Prompt Format

When at least one snippet is enabled and has content available, the extension appends a block like this to the system prompt on every turn:

```
## System Context

- You are running the Pi Harness
- Current model: openai/gpt-4o
- Current provider: openai
- Current thinking level: medium
- Session tokens: 12,345 total (8,432 input, 3,913 output) · $0.0421
- Current working directory: /home/user/projects/my-app
- Active workflow: review-plan  (published by another extension)
```

If no snippets are enabled or no content is available, nothing is appended.

## Inter-Extension API

Other Pi extensions can publish their own context snippets dynamically via the inter-extension event bus (`pi.events`). This is useful for workflow engines, subagent managers, or any extension that wants to make its state visible to the LLM.

### Events

#### `system-context:register`

Register a new snippet. Emit once during extension initialisation or when your context first becomes relevant.

```typescript
pi.events.emit("system-context:register", {
  id: "my-ext:workflow",        // required — use namespaced IDs
  label: "Workflow",            // required — human-readable name
  description: "Current workflow step",  // required
  defaultEnabled: true,         // optional — defaults to true
});
```

#### `system-context:update`

Update the snippet's content. Emit whenever your state changes. Set `content` to `null` to hide the snippet temporarily without unregistering it.

```typescript
pi.events.emit("system-context:update", {
  id: "my-ext:workflow",        // must match registered id
  content: "Active workflow: review-plan",
});

// Hide without unregistering
pi.events.emit("system-context:update", {
  id: "my-ext:workflow",
  content: null,
});
```

#### `system-context:unregister`

Remove a snippet completely. Use this during cleanup or when your extension's context is no longer relevant.

```typescript
pi.events.emit("system-context:unregister", {
  id: "my-ext:workflow",
});
```

### Namespacing Convention

To avoid ID collisions between extensions, use a namespace prefix:

```
extension-name:snippet-id
```

Examples:
- `workflow-engine:active-step`
- `subagent-manager:current-role`
- `git-status:branch`

Built-in IDs (`harness`, `model`, `provider`, `cwd`) are reserved and cannot be overridden by external extensions.

### Full Example

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  let activeWorkflow: string | null = null;

  // Register once
  pi.on("session_start", async () => {
    pi.events.emit("system-context:register", {
      id: "my-ext:workflow",
      label: "Workflow",
      description: "Current workflow step",
      defaultEnabled: true,
    });
  });

  // Update when workflow changes
  function setWorkflow(name: string | null) {
    activeWorkflow = name;
    pi.events.emit("system-context:update", {
      id: "my-ext:workflow",
      content: name ? `Active workflow: ${name}` : null,
    });
  }

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    pi.events.emit("system-context:unregister", {
      id: "my-ext:workflow",
    });
  });
}
```

## State Persistence

Enable/disable toggles for both built-in and external snippets are persisted in the Pi session file via `appendEntry`. They survive session restarts and `/reload`.

## Licence

See [LICENSE](./LICENSE).
