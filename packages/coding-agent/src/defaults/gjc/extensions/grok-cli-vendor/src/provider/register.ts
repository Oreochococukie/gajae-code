/**
 * GJC Grok Build provider — SuperGrok OAuth + cli-chat-proxy models.
 */

import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from '@gajae-code/ai';
import type { ExtensionAPI, ProviderConfig } from '@gajae-code/coding-agent';
import * as oauth from '../auth/oauth.js';
import { getBaseUrl, type XaiOAuthCredentials } from '../auth/oauth.js';
import { type GrokCliModelConfig, resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { registerGrokTools } from '../tools/register.js';
import { streamGrokCli } from './stream.js';
import { syncGrokTools } from './toolScope.js';
import { registerUsageCommand } from './usage.js';

export default function registerGrokCli(api: ExtensionAPI) {
  const baseUrl = getBaseUrl();
  const models = resolveModels();

  api.on('model_select', (event) => {
    syncGrokTools(api, event.model.provider);
  });

  api.on('before_agent_start', (_event, ctx) => {
    syncGrokTools(api, ctx.model?.provider);
  });

  api.registerProvider('grok-cli', {
    name: 'Grok Build',
    baseUrl,
    apiKey: '$GROK_CLI_OAUTH_TOKEN',
    api: 'grok-cli-responses',
    models: models.map((m: GrokCliModelConfig) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      thinkingLevelMap: m.thinkingLevelMap,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    oauth: {
      name: 'Grok Build',

      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        return oauth.login(callbacks);
      },

      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return oauth.refresh(credentials);
      },

      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },

      modifyModels(models: Model<Api>[], credentials: OAuthCredentials) {
        const effectiveBaseUrl = String(
          (credentials as XaiOAuthCredentials).baseUrl ?? getBaseUrl(),
        ).replace(/\/+$/, '');

        return models.map((m) =>
          m.provider === 'grok-cli' ? { ...m, baseUrl: effectiveBaseUrl } : m,
        );
      },
    } satisfies ProviderConfig['oauth'],

    streamSimple: streamGrokCli,
  });

  registerGrokTools(api);

  api.on('session_start', (_event, ctx) => {
    if (process.env.GROK_CLI_OAUTH_TOKEN) {
      ctx.ui.notify(
        '[Grok Build] Using GROK_CLI_OAUTH_TOKEN env bypass — no auto-refresh, no model discovery',
        'warning',
      );
    }

  });

  api.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'grok-cli') return;

    const modelId = ctx.model?.id ?? '';
    const sessionId = ctx.sessionManager?.getSessionId();
    return sanitizePayload(event.payload as Record<string, unknown>, modelId, sessionId, ctx.cwd);
  });

  registerUsageCommand(api);
}
