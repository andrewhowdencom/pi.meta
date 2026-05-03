# Plan: Create System Context Extension for Pi Harness

## Objective

Build a Pi extension that injects configurable context snippets into the system prompt, providing the LLM with metadata about its execution environment. The extension supports two categories of snippets: (1) built-in environment snippets (harness identity, model, provider, working directory) and (2) dynamically registered snippets from other extensions (e.g., workflow state, subagent status). All snippets are individually enable/disable-able, with the three built-in environment snippets enabled by default. Other extensions publish their context via Pi's inter-extension event bus (`pi.events`).

## Context

**Project**: `pi.meta` — a Pi extension project whose README states: "Pi (Harness): Injects information into the agent context about the harness, the agent, the environment and so on." The project currently contains only `README.md` and an empty `.pi/` directory.

**Pi Extension API** (discovered from `/home/andrewhowdencom/.nvm/versions/node/v25.0.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` and examples):

- **`before_agent_start` event**: Fires before each agent turn. Can modify `systemPrompt` by returning `{ systemPrompt: string }`. The `event.systemPrompt` reflects prior chained modifications. Also provides `event.systemPromptOptions` with structured metadata including `.cwd` (working directory).
- **`model_select` event**: Fires when the active model changes (via `/model`, Ctrl+P cycling, or session restore). Provides `event.model` with `{ provider: string, id: string }` and `event.source`.
- **`session_start` event**: Fires at session initialization. Used to restore persisted state from session entries.
- **`pi.appendEntry(type, data)`**: Persists extension state into the session file (non-LLM-visible). State survives session restarts.
- **`ctx.sessionManager.getEntries()`**: Iterate session entries to restore state on `session_start`.
- **`pi.registerCommand(name, options)`**: Register slash commands like `/system-context` for user interaction.
- **`ctx.ui.notify(message, type)` / `ctx.ui.setStatus(key, text)`**: UI feedback mechanisms.
- **`pi.events` (EventEmitter)**: Inter-extension event bus. One extension can `emit()` events that another extension listens to via `pi.events.on()`. Extensions run in the same Node.js process, so event payloads can include any JavaScript value including closures.

**Relevant examples studied**:
- `pirate.ts`: Demonstrates `before_agent_start` system prompt modification with toggleable state.
- `model-status.ts`: Demonstrates `model_select` event for tracking active model/provider.
- `system-prompt-header.ts`: Demonstrates `ctx.getSystemPrompt()` access.
- `prompt-customizer.ts`: Demonstrates `systemPromptOptions` usage for context-aware modifications.
- `session-name.ts`: Demonstrates simple command registration pattern.
- `event-bus.ts`: Demonstrates `pi.events` for inter-extension communication (`pi.events.emit` / `pi.events.on`).

## Architectural Blueprint

### Selected Architecture: Two-Tier Snippet Registry with Inter-Extension Event Bus

After evaluating approaches:

- **Option A (Hardcoded toggles only)**: Simple but not extensible. Rejected because the user explicitly wants both built-in extensibility and third-party extension contributions.
- **Option B (Global singleton API)**: Expose a global function other extensions can call. Works but bypasses Pi's idiomatic event bus and creates implicit coupling. Rejected.
- **Option C (Event bus with register/update/unregister lifecycle)**: **Selected.** Uses Pi's built-in `pi.events` for clean, decoupled inter-extension communication. Built-in snippets are pre-registered internally; external extensions emit events to publish their own snippets.

**Components**:

1. **Built-in Snippet Registry**: Four statically defined `BuiltinSnippet` objects with `generate(data)` functions that produce text from runtime data (model info, cwd).

2. **External Snippet Registry**: A `Map<string, ExternalSnippet>` populated via inter-extension events. Each external snippet has metadata (`id`, `label`, `description`, `defaultEnabled`) and mutable `content` that other extensions update dynamically.

3. **State Manager**: Tracks:
   - `currentModel`: `{ provider: string, id: string } | null` — from `model_select`
   - `builtinConfig`: `Record<string, boolean>` — enable/disable for built-in snippets
   - `externalConfig`: `Record<string, boolean>` — enable/disable for external snippets
   - `externalSnippets`: `Map<string, ExternalSnippet>` — live external snippet data
   All config is persisted via `appendEntry` and restored on `session_start`.

4. **Inter-Extension Event API**: Other extensions communicate via `pi.events`:
   - `system-context:register` — one-time metadata registration
   - `system-context:update` — dynamic content updates per turn
   - `system-context:unregister` — cleanup when extension shuts down

5. **System Prompt Injector**: In `before_agent_start`, collects all enabled snippets (built-in + external with non-null content), formats them as a `## System Context` block, and appends to the system prompt.

6. **Command Interface**: `/system-context` command with subcommands for inspecting and toggling both built-in and external snippets.

## Requirements

1. The extension must inject a `## System Context` section into the system prompt on every agent turn.
2. The section must contain only snippets that are currently enabled and have available content.
3. **Built-in snippets** (pre-registered by the extension itself):
   - `harness`: "You are running the Pi Harness" [static]
   - `model`: "Current model: {provider}/{id}" [from `model_select`]
   - `provider`: "Current provider: {provider}" [from `model_select`]
   - `cwd`: "Current working directory: {cwd}" [from `systemPromptOptions.cwd`]
4. `harness`, `model`, and `provider` must be **enabled by default**.
5. `cwd` must be **disabled by default**.
6. Each built-in snippet must be individually toggleable via `/system-context toggle <id>`.
7. Configuration must persist across session restarts using `appendEntry`.
8. The current model must be tracked via the `model_select` event and survive across turns.
9. If model info is unavailable, the `model` and `provider` snippets must gracefully omit themselves.
10. **Inter-extension API**: Other extensions must be able to publish context snippets dynamically via `pi.events`.
11. External snippets must follow a register → update lifecycle: extensions emit `system-context:register` once for metadata, then `system-context:update` whenever their content changes.
12. External snippets must be individually toggleable by the user alongside built-in snippets.
13. When an extension unregisters (emits `system-context:unregister`), its snippet must be removed from the registry and configuration.
14. External snippet `id`s should follow a namespaced convention (e.g., `my-ext:workflow`) to avoid collisions, though the system does not need to enforce this.

## Task Breakdown

### Task 1: Create Extension File Structure
- **Goal**: Initialize the extension source file with TypeScript imports and default export boilerplate.
- **Dependencies**: None.
- **Files Affected**: None (new file).
- **New Files**: `.pi/extensions/system-context.ts` (or `index.ts` at project root with symlink/copy for local testing).
- **Interfaces**: `import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"` in the factory function signature.
- **Details**: Create the extension file with the standard Pi extension boilerplate (`export default function (pi: ExtensionAPI) { ... }`). Place it in `.pi/extensions/system-context.ts` so Pi auto-discovers it for local testing. No npm dependencies are required — the extension uses only Pi's built-in API and TypeScript built-ins.

### Task 2: Define Snippet Types and Built-in Registry
- **Goal**: Define TypeScript interfaces for all snippet types and register the four built-in snippets.
- **Dependencies**: Task 1.
- **Files Affected**: `.pi/extensions/system-context.ts`.
- **New Files**: None.
- **Interfaces**:
  ```typescript
  interface SnippetData {
    model: { provider: string; id: string } | null;
    cwd: string;
  }

  interface BuiltinSnippet {
    id: string;
    label: string;
    description: string;
    defaultEnabled: boolean;
    generate: (data: SnippetData) => string | null;
  }

  interface ExternalSnippet {
    id: string;
    label: string;
    description: string;
    defaultEnabled: boolean;
    content: string | null;  // null = no content yet, omit from prompt
  }

  interface ExternalSnippetRegistration {
    id: string;
    label: string;
    description: string;
    defaultEnabled: boolean;
  }

  interface ExternalSnippetUpdate {
    id: string;
    content: string | null;
  }
  ```
- **Details**: Implement the `BUILTINS` array containing all four built-in snippets. Each `generate()` function returns the formatted text string or `null` if data is unavailable. The `harness` snippet is static. `model` and `provider` check `data.model` for null. `cwd` uses `data.cwd`.

### Task 3: Implement State Management
- **Goal**: Track current model info, manage built-in and external snippet configuration, and persist state across sessions.
- **Dependencies**: Task 2.
- **Files Affected**: `.pi/extensions/system-context.ts`.
- **New Files**: None.
- **Interfaces**:
  ```typescript
  const STATE_TYPE = "system-context-config";
  interface PersistedState {
    builtinConfig: Record<string, boolean>;
    externalConfig: Record<string, boolean>;
  }
  ```
- **Details**:
  1. Maintain in-memory `currentModel` variable updated by `pi.on("model_select", ...)`.
  2. Maintain `builtinConfig` initialized from each built-in snippet's `defaultEnabled`.
  3. Maintain `externalSnippets` as a `Map<string, ExternalSnippet>`.
  4. Maintain `externalConfig` as a `Record<string, boolean>`.
  5. On `session_start`, iterate `ctx.sessionManager.getEntries()` to find entries with `customType === STATE_TYPE`. Merge the persisted `builtinConfig` and `externalConfig` into the in-memory state.
  6. On any config change (toggle, reset, external registration), call `pi.appendEntry(STATE_TYPE, { builtinConfig, externalConfig })` to persist.
  7. Handle `source === "restore"` in `model_select` — update model but suppress notification.

### Task 4: Implement Inter-Extension Event Listeners
- **Goal**: Listen for `system-context:*` events from other extensions and manage the external snippet registry.
- **Dependencies**: Task 2, Task 3.
- **Files Affected**: `.pi/extensions/system-context.ts`.
- **New Files**: None.
- **Interfaces**: Event payloads as defined in Task 2.
- **Details**:
  1. Listen on `pi.events.on("system-context:register", (payload) => { ... })`:
     - Validate payload has required fields (`id`, `label`, `description`).
     - Create or update the `ExternalSnippet` in the `externalSnippets` map.
     - If this is a new registration and no persisted config exists for this `id`, initialize `externalConfig[id]` to `payload.defaultEnabled`.
     - Persist the updated config.
  2. Listen on `pi.events.on("system-context:update", (payload) => { ... })`:
     - Look up the snippet by `id` in `externalSnippets`.
     - If found, update its `content` field. If not found, silently ignore (or log a warning).
  3. Listen on `pi.events.on("system-context:unregister", (payload) => { ... })`:
     - Remove the snippet from `externalSnippets`.
     - Remove its entry from `externalConfig`.
     - Persist the updated config.
  4. Register a custom tool (optional) that the LLM can use to inspect external snippet status. Alternatively, rely solely on the `/system-context` command for human interaction.

### Task 5: Implement System Prompt Injection
- **Goal**: In `before_agent_start`, collect all enabled snippets (built-in and external) and append them to the system prompt.
- **Dependencies**: Task 2, Task 3, Task 4.
- **Files Affected**: `.pi/extensions/system-context.ts`.
- **New Files**: None.
- **Interfaces**: Returns `{ systemPrompt: string } | undefined` from `before_agent_start` handler.
- **Details**:
  1. In `pi.on("before_agent_start", (event) => { ... })`:
  2. Build `SnippetData` from `currentModel` and `event.systemPromptOptions.cwd`.
  3. Collect built-in snippets: filter `BUILTINS` where `builtinConfig[snippet.id]` is `true`, map through `generate(data)`, filter out `null`.
  4. Collect external snippets: iterate `externalSnippets` values, filter where `externalConfig[id]` is `true` and `content !== null`, use `content` directly.
  5. If no enabled snippets produce text, return `undefined` (no modification).
  6. Otherwise, append a formatted block:
     ```
     ## System Context

     - {snippet text 1}
     - {snippet text 2}
     ...
     ```
  7. Return `{ systemPrompt: event.systemPrompt + "\n\n" + block }`.

### Task 6: Implement User Commands
- **Goal**: Provide `/system-context` commands for users to inspect and manage both built-in and external snippet settings.
- **Dependencies**: Task 2, Task 3, Task 4.
- **Files Affected**: `.pi/extensions/system-context.ts`.
- **New Files**: None.
- **Interfaces**:
  ```typescript
  pi.registerCommand("system-context", {
    description: "Manage system context snippets (usage: /system-context [toggle <id> | reset])",
    handler: async (args, ctx) => { ... }
  });
  ```
- **Details**:
  1. Parse command arguments:
     - No args: display all built-in and external snippets with `[enabled]` / `[disabled]` markers
     - `toggle <id>`: flip the appropriate config (`builtinConfig` or `externalConfig`), persist, and notify
     - `reset`: reset all configs to defaults, clear all external snippets, persist, and notify
  2. Validate `id` against registered snippets; notify error if invalid.
  3. Use `ctx.ui.notify()` for user feedback.
  4. The status display should group built-in and external snippets, showing `id`, `label`, `description`, and current state.

### Task 7: Write Project README and Extension Documentation
- **Goal**: Document the extension's purpose, installation, built-in snippets, inter-extension API, and user commands.
- **Dependencies**: Task 1–6.
- **Files Affected**: `README.md`.
- **New Files**: None (rewrite existing).
- **Interfaces**: None.
- **Details**: Update `README.md` to include:
  - What the extension does and why
  - Installation instructions (copy to `~/.pi/agent/extensions/` or `.pi/extensions/`)
  - List of built-in snippets with defaults
  - **Inter-extension API documentation**: Full event reference (`system-context:register`, `system-context:update`, `system-context:unregister`) with TypeScript examples
  - User command reference (`/system-context`)
  - Example of injected system prompt output
  - Namespacing convention for external snippet IDs

## Dependency Graph

- Task 1 → Task 2 → Task 3 → Task 4 → Task 5
- Task 2 → Task 3 → Task 6
- Task 5 || Task 6 (parallel after Task 4 completes)
- Task 1–6 → Task 7

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| `model_select` does not fire on initial session start, leaving model info null | High | Medium | Listen to `session_start` and check if model info is available via any API; if not, accept that model/provider snippets will be omitted until first model event. The `generate()` functions already return `null` gracefully. |
| `systemPromptOptions.cwd` is empty or undefined in some contexts | Low | Low | Check for empty/undefined `cwd` and skip the `cwd` snippet. |
| Extension conflicts with other `before_agent_start` handlers that also append to system prompt | Medium | Medium | Append at the end (natural chaining behavior). Pi's chained system prompt mechanism means later handlers see earlier modifications. The extension appends its block, so it should coexist with other extensions. |
| `appendEntry` state grows unbounded with repeated toggles | Low | Low | Each toggle appends a new entry. This is standard Pi behavior; the session file will contain history. If it becomes an issue, a future enhancement could compact entries. |
| External extension registers with a colliding `id` | Medium | Low | Document namespacing convention (`ext-name:snippet-id`). Do not enforce at runtime — last registration wins, which is acceptable for loosely-coupled extensions. |
| External extension emits `update` before `register` | Low | Medium | Silently ignore updates for unregistered IDs. Optionally log a warning to the console for debugging. |
| `pi.events` listener leaks on extension reload | Medium | Low | Re-register listeners each time the extension loads. Pi's extension lifecycle ensures old handlers are discarded on reload (the old extension instance is replaced). |
| Inter-extension event bus is not available in all Pi versions | High | Low | The `event-bus.ts` example is in the official examples, confirming this is a supported API. If unavailable, the extension gracefully degrades to built-in snippets only. |

## Validation Criteria

- [ ] Extension loads without errors when Pi starts.
- [ ] `/system-context` with no arguments displays all 4 built-in snippets with correct default states (harness=on, model=on, provider=on, cwd=off).
- [ ] `/system-context toggle cwd` enables the CWD snippet; calling again disables it.
- [ ] After toggling a snippet, `session_start` restores the correct state when the session is reloaded.
- [ ] `before_agent_start` appends a `## System Context` block containing enabled built-in snippets.
- [ ] The `model` snippet shows the correct `provider/id` after a model is selected.
- [ ] The `provider` snippet shows the correct provider name.
- [ ] The `cwd` snippet shows the current working directory from `systemPromptOptions.cwd`.
- [ ] When all snippets are disabled, no `## System Context` block is injected.
- [ ] **Inter-extension**: A test extension can emit `system-context:register`, `system-context:update`, and see its content appear in the system prompt.
- [ ] **Inter-extension**: A test extension can emit `system-context:unregister` and its snippet disappears.
- [ ] **Inter-extension**: External snippets respect `defaultEnabled` on first registration.
- [ ] **Inter-extension**: External snippets can be toggled via `/system-context toggle <id>`.
- [ ] README accurately documents installation, built-in snippets, inter-extension API, and commands.
