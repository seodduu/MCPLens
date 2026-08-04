export type ConfiguredInferenceProvider = 'auto' | 'claude' | 'codex';
export type ResolvedInferenceProvider = Exclude<ConfiguredInferenceProvider, 'auto'>;

export interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export interface ProviderConfig {
  provider: ConfiguredInferenceProvider;
  claudeModel: string;
  codexModel: string;
}

export interface ProviderAvailability {
  claude: boolean;
  codex: boolean;
}

export type ProviderResolution =
  | { kind: 'resolved'; provider: ResolvedInferenceProvider; model: string }
  | { kind: 'choose'; choices: ResolvedInferenceProvider[] }
  | { kind: 'unavailable' };

export function readProviderConfig(configuration: ConfigurationReader): ProviderConfig {
  return {
    provider: configuration.get<ConfiguredInferenceProvider>('inferenceProvider', 'auto'),
    claudeModel: configuration.get<string>('claudeModel', 'haiku'),
    codexModel: configuration.get<string>('codexModel', 'gpt-5.6-luna'),
  };
}

export function resolveProvider(config: ProviderConfig, availability: ProviderAvailability): ProviderResolution {
  const modelFor = (provider: ResolvedInferenceProvider) =>
    provider === 'claude' ? config.claudeModel : config.codexModel;
  if (config.provider !== 'auto') {
    return availability[config.provider]
      ? { kind: 'resolved', provider: config.provider, model: modelFor(config.provider) }
      : { kind: 'unavailable' };
  }
  if (availability.claude && availability.codex) return { kind: 'choose', choices: ['claude', 'codex'] };
  if (availability.claude) return { kind: 'resolved', provider: 'claude', model: modelFor('claude') };
  if (availability.codex) return { kind: 'resolved', provider: 'codex', model: modelFor('codex') };
  return { kind: 'unavailable' };
}
