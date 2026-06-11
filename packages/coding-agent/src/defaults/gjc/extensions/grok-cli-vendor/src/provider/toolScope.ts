import type { ExtensionAPI } from '@gajae-code/coding-agent';
import {
  GROK_SUPPRESSED_TOOL_NAMES,
  GROK_TOOL_NAMES_FOR_SCOPE,
  grokToolsToActivate,
} from '../tools/register.js';

const preservedSuppressedTools = new WeakMap<object, string[]>();

export function syncGrokTools(
  api: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>,
  provider: string | undefined,
) {
  const currentTools = api.getActiveTools();
  const baseTools = currentTools.filter(
    (toolName) =>
      !GROK_TOOL_NAMES_FOR_SCOPE.includes(toolName as (typeof GROK_TOOL_NAMES_FOR_SCOPE)[number]),
  );
  const suppressedTools = baseTools.filter((toolName) =>
    GROK_SUPPRESSED_TOOL_NAMES.includes(toolName as (typeof GROK_SUPPRESSED_TOOL_NAMES)[number]),
  );
  if (suppressedTools.length > 0) preservedSuppressedTools.set(api, suppressedTools);

  const nextTools =
    provider === 'grok-cli'
      ? [
          ...baseTools.filter((toolName) => !suppressedTools.includes(toolName)),
          ...grokToolsToActivate(),
        ]
      : [
          ...baseTools,
          ...(preservedSuppressedTools.get(api) ?? []).filter(
            (toolName) => !baseTools.includes(toolName),
          ),
        ];

  if (provider !== 'grok-cli') preservedSuppressedTools.delete(api);

  if (
    currentTools.length === nextTools.length &&
    currentTools.every((toolName, i) => toolName === nextTools[i])
  ) {
    return;
  }

  api.setActiveTools(nextTools);
}
