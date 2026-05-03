import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
	content: string | null;
}

interface ExternalSnippetRegistration {
	id: string;
	label: string;
	description: string;
	defaultEnabled?: boolean;
}

interface ExternalSnippetUpdate {
	id: string;
	content: string | null;
}

interface PersistedState {
	builtinConfig: Record<string, boolean>;
	externalConfig: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Built-in Snippets
// ---------------------------------------------------------------------------

const BUILTINS: BuiltinSnippet[] = [
	{
		id: "harness",
		label: "Pi Harness",
		description: "Indicates the agent is running within the Pi Harness",
		defaultEnabled: true,
		generate: () => "You are running the Pi Harness",
	},
	{
		id: "model",
		label: "Current Model",
		description: "Shows the active LLM model (provider/id)",
		defaultEnabled: true,
		generate: (data) => {
			if (!data.model) return null;
			let id = data.model.id;
			// Strip account-based model hosting paths: accounts/{account}/models/{model}
			const modelsIndex = id.indexOf('/models/');
			if (id.startsWith('accounts/') && modelsIndex !== -1) {
				id = id.slice(modelsIndex + '/models/'.length);
			}
			return `Current model: ${data.model.provider}/${id}`;
		},
	},
	{
		id: "provider",
		label: "Current Provider",
		description: "Shows the active LLM provider",
		defaultEnabled: true,
		generate: (data) => {
			if (!data.model) return null;
			return `Current provider: ${data.model.provider}`;
		},
	},
	{
		id: "datetime",
		label: "Date and Time",
		description: "Shows the current date and time in ISO 8601 format",
		defaultEnabled: false,
		generate: () => {
			const now = new Date();
			return `Current date and time: ${now.toISOString()}`;
		},
	},
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_TYPE = "system-context-config";

// ---------------------------------------------------------------------------
// Extension Factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- In-memory state -----------------------------------------------------
	let currentModel: { provider: string; id: string } | null = null;
	const builtinConfig: Record<string, boolean> = {};
	const externalSnippets = new Map<string, ExternalSnippet>();
	const externalConfig: Record<string, boolean> = {};

	// Initialise built-in defaults
	for (const snippet of BUILTINS) {
		builtinConfig[snippet.id] = snippet.defaultEnabled;
	}

	// --- Helpers ------------------------------------------------------------

	function persistState() {
		const state: PersistedState = {
			builtinConfig: { ...builtinConfig },
			externalConfig: { ...externalConfig },
		};
		pi.appendEntry(STATE_TYPE, state);
	}

	function restoreState(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getEntries();
		let lastState: PersistedState | null = null;
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data) {
				lastState = entry.data as PersistedState;
			}
		}
		if (lastState) {
			if (lastState.builtinConfig) {
				Object.assign(builtinConfig, lastState.builtinConfig);
			}
			if (lastState.externalConfig) {
				Object.assign(externalConfig, lastState.externalConfig);
			}
		}
	}

	function getSnippetLabel(id: string): string {
		const builtin = BUILTINS.find((s) => s.id === id);
		if (builtin) return builtin.label;
		const external = externalSnippets.get(id);
		if (external) return external.label;
		return id;
	}

	function isSnippetValid(id: string): boolean {
		return BUILTINS.some((s) => s.id === id) || externalSnippets.has(id);
	}

	// --- Lifecycle events ---------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("model_select", async (event) => {
		currentModel = { provider: event.model.provider, id: event.model.id };
	});

	// --- Inter-extension event bus ------------------------------------------

	pi.events.on("system-context:register", (payload: unknown) => {
		const reg = payload as ExternalSnippetRegistration;
		if (!reg.id || !reg.label || !reg.description) {
			console.warn("[system-context] Invalid register payload:", reg);
			return;
		}
		const snippet: ExternalSnippet = {
			id: reg.id,
			label: reg.label,
			description: reg.description,
			defaultEnabled: reg.defaultEnabled ?? true,
			content: null,
		};
		externalSnippets.set(reg.id, snippet);
		if (!(reg.id in externalConfig)) {
			externalConfig[reg.id] = snippet.defaultEnabled;
			persistState();
		}
	});

	pi.events.on("system-context:update", (payload: unknown) => {
		const update = payload as ExternalSnippetUpdate;
		if (!update.id) {
			console.warn("[system-context] Invalid update payload:", update);
			return;
		}
		const snippet = externalSnippets.get(update.id);
		if (!snippet) {
			// Silently ignore updates for unregistered IDs
			return;
		}
		snippet.content = update.content ?? null;
	});

	pi.events.on("system-context:unregister", (payload: unknown) => {
		const unreg = payload as { id: string };
		if (!unreg.id) return;
		externalSnippets.delete(unreg.id);
		delete externalConfig[unreg.id];
		persistState();
	});

	// --- System prompt injection --------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		// model_select only fires on explicit changes; fallback to ctx.model for startup
		const model = currentModel ?? (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null);
		const data: SnippetData = {
			model,
			cwd: event.systemPromptOptions.cwd || "",
		};

		const parts: string[] = [];

		// Built-in snippets
		for (const snippet of BUILTINS) {
			if (!builtinConfig[snippet.id]) continue;
			const text = snippet.generate(data);
			if (text) parts.push(text);
		}

		// External snippets
		for (const [id, snippet] of externalSnippets) {
			if (!externalConfig[id]) continue;
			if (snippet.content === null) continue;
			parts.push(snippet.content);
		}

		if (parts.length === 0) return undefined;

		const block = `## System Context\n\n${parts.map((p) => `- ${p}`).join("\n")}`;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + block,
		};
	});

	// --- User commands ------------------------------------------------------

	pi.registerCommand("system-context", {
		description: "Manage system context snippets (usage: /system-context [toggle <id> | reset])",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [subcmd, ...rest] = trimmed.split(/\s+/);

			if (!subcmd) {
				// List all snippets
				const lines: string[] = ["System Context Snippets:"];

				lines.push("");
				lines.push("Built-in:");
				for (const snippet of BUILTINS) {
					const state = builtinConfig[snippet.id] ? "enabled" : "disabled";
					lines.push(`  [${state}] ${snippet.id} — ${snippet.label}: ${snippet.description}`);
				}

				if (externalSnippets.size > 0) {
					lines.push("");
					lines.push("External:");
					for (const [id, snippet] of externalSnippets) {
						const state = externalConfig[id] ? "enabled" : "disabled";
						lines.push(`  [${state}] ${id} — ${snippet.label}: ${snippet.description}`);
					}
				}

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (subcmd === "toggle") {
				const id = rest.join(" ").trim();
				if (!id) {
					ctx.ui.notify("Usage: /system-context toggle <id>", "error");
					return;
				}
				if (!isSnippetValid(id)) {
					ctx.ui.notify(`Unknown snippet: ${id}`, "error");
					return;
				}
				if (id in builtinConfig) {
					builtinConfig[id] = !builtinConfig[id];
				} else if (id in externalConfig) {
					externalConfig[id] = !externalConfig[id];
				}
				persistState();
				const newState = (id in builtinConfig ? builtinConfig[id] : externalConfig[id]) ? "enabled" : "disabled";
				ctx.ui.notify(`${getSnippetLabel(id)} is now ${newState}`, "info");
				return;
			}

			if (subcmd === "reset") {
				// Reset built-in defaults
				for (const snippet of BUILTINS) {
					builtinConfig[snippet.id] = snippet.defaultEnabled;
				}
				// Clear external snippets and config
				for (const id of Array.from(externalSnippets.keys())) {
					delete externalConfig[id];
				}
				externalSnippets.clear();
				persistState();
				ctx.ui.notify("System context snippets reset to defaults", "info");
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${subcmd}. Usage: /system-context [toggle <id> | reset]`, "error");
		},
	});
}
