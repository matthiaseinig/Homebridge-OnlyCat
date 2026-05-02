export function redactToken(token: string | undefined | null): string {
  if (!token) return "<missing>";
  if (token.length <= 4) return "***";
  return `${token.slice(0, 4)}***`;
}
