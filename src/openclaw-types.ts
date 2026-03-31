/**
 * Minimal OpenClaw plugin type definitions.
 *
 * These mirror the subset of the OpenClaw Plugin SDK that this plugin uses.
 * At runtime, the real types come from openclaw/plugin-sdk — these exist
 * only so the plugin typechecks standalone without the full openclaw package.
 */

export type PluginLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error?: (message: string) => void;
};

export type OpenClawPluginApi = {
  id: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  on: (hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }) => void;
  registerTool: (tool: any, opts?: { name?: string }) => void;
  registerService: (service: { name: string; stop?: () => Promise<void> | void }) => void;
};

type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
};

type DefinedPluginEntry = DefinePluginEntryOptions;

/**
 * Standalone definePluginEntry that works without the openclaw package.
 * At runtime, OpenClaw's loader invokes the register function directly.
 */
export function definePluginEntry(options: DefinePluginEntryOptions): DefinedPluginEntry {
  return options;
}
