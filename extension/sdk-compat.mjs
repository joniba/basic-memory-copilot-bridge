const currentSdk = '@microsoft/copilot-sdk/extension';
const legacySdk = '@github/copilot-sdk/extension';

export async function joinSession(options, loadSdk = specifier => import(specifier)) {
  let sdk;
  try {
    sdk = await loadSdk(currentSdk);
  } catch (error) {
    // Missing dependencies inside the current SDK must not trigger fallback.
    if (error?.code !== 'ERR_MODULE_NOT_FOUND'
      || !/^Cannot find package '@microsoft\/copilot-sdk'(?:\s|$)/.test(error.message)) throw error;
    return (await loadSdk(legacySdk)).joinSession(options);
  }
  const { tools, hooks, commands, ...rest } = options;
  return sdk.joinSession({
    ...rest,
    ...(tools === undefined ? {} : { tools: { definitions: tools } }),
    ...(hooks === undefined ? {} : { hooks: { handlers: hooks } }),
    ...(commands === undefined ? {} : { interaction: { ...rest.interaction, commands } }),
  });
}
