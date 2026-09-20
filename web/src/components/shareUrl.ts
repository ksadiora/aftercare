/** Preserve public tunnel URLs; use the current web port for an advertised LAN host. */
export function shareUrl(pathname: string, phoneUrls: string[] = [], origin = location.origin): string {
  const current = new URL(origin);
  const local = (host: string) => /^(localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/.test(host);
  const lan = (host: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|\[(fc|fd|fe80))/.test(host);
  const candidates = phoneUrls.flatMap((value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !local(url.hostname) ? [url] : [];
    } catch { return []; }
  });
  // The server orders public overrides first, then physical network interfaces, then VPNs.
  const advertised = candidates[0];
  const publicUrl = advertised && !lan(advertised.hostname) ? advertised : undefined;
  const base = publicUrl ?? current;
  if (!publicUrl && local(current.hostname) && candidates[0]) base.hostname = candidates[0].hostname;
  return new URL(pathname, base.origin).href;
}
