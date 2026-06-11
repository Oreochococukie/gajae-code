import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  streamSimple,
} from '@gajae-code/ai';

const GROK_CLI_VERSION = '0.2.33';

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * GJC Grok Build extension sends cli-chat-proxy headers (see agent.models.grok-cli.yml):
 *   - x-grok-conv-id: <session/conversation ID>
 *   - x-grok-model-override: <model ID>
 *   - x-xai-token-auth: xai-grok-cli
 */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;
  const headers: Record<string, string> = {
    ...options?.headers,
    'x-grok-client-identifier': 'gjc-grok-cli',
    'x-grok-client-version': GROK_CLI_VERSION,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': model.id,
  };

  if (sessionId) {
    headers['x-grok-conv-id'] = sessionId;
  }

  return streamSimple(model as Model<'grok-cli-responses'>, context, {
    ...options,
    headers,
    onResponse(response) {
      options?.onResponse?.(response, model);
    },
  });
}
