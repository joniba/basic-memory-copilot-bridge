import assert from 'node:assert/strict';
import test from 'node:test';
import { joinSession } from '../extension/sdk-compat.mjs';

test('registers the checkpoint command without dropping other current SDK interaction options', async () => {
  const commands = [{ name: 'bm-bridge', handler() {} }];
  const onUserInputRequest = () => {};
  await joinSession({ tools: [], hooks: {}, commands, interaction: { onUserInputRequest } }, async (specifier) => {
    assert.equal(specifier, '@microsoft/copilot-sdk/extension');
    return { joinSession: options => {
      assert.deepEqual(options.tools, { definitions: [] });
      assert.deepEqual(options.hooks, { handlers: {} });
      assert.deepEqual(options.interaction, { onUserInputRequest, commands });
    } };
  });
});

test('preserves flat registration on older hosts and surfaces errors inside a present SDK', async () => {
  const options = { tools: [], hooks: {}, commands: [{ name: 'bm-bridge', handler() {} }] };
  const missing = name => Object.assign(new Error(`Cannot find package '${name}'`), { code: 'ERR_MODULE_NOT_FOUND' });
  await joinSession(options, async specifier => {
    if (specifier === '@microsoft/copilot-sdk/extension') throw missing('@microsoft/copilot-sdk');
    assert.equal(specifier, '@github/copilot-sdk/extension');
    return { joinSession: received => assert.equal(received, options) };
  });
  const failure = missing('dependency');
  await assert.rejects(joinSession(options, async specifier => {
    assert.equal(specifier, '@microsoft/copilot-sdk/extension');
    throw failure;
  }), error => error === failure);
});
