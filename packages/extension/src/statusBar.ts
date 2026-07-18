export function formatStatus(callCount: number, savedTokens: number): string {
  const saved = savedTokens >= 1000 ? `${(Math.floor(savedTokens / 100) / 10).toFixed(1)}k` : `${savedTokens}`;
  return `Lens: ${callCount} calls · ${saved} saved`;
}
