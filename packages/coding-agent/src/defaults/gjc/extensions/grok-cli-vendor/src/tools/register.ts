import type { ExtensionAPI } from '@gajae-code/coding-agent';
import { registerFileTools } from './files.js';
import { registerSearchTools } from './search.js';
import { registerShellTool } from './shell.js';

/** Grok/Cursor shims always registered by this extension. */
export const GROK_SHIM_TOOL_NAMES = [
  'Grep',
  'Glob',
  'LS',
  'Read',
  'Write',
  'StrReplace',
  'Edit',
  'Delete',
  'Shell',
] as const;

/** All shim names used when reconciling the active tool set. */
export const GROK_TOOL_NAMES_FOR_SCOPE = GROK_SHIM_TOOL_NAMES;

export const GROK_SUPPRESSED_TOOL_NAMES = ['web_search'] as const;

export function grokToolsToActivate() {
  return [...GROK_SHIM_TOOL_NAMES];
}

export function registerGrokTools(api: ExtensionAPI) {
  registerSearchTools(api);
  registerFileTools(api);
  registerShellTool(api);
}
