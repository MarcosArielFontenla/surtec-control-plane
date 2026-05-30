// Converts a git remote into a github.com web URL, or null when it is not a GitHub remote.
export function githubWebUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const s = remote.trim();
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i,
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i,
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return `https://github.com/${m[1]}/${m[2]}`;
  }
  return null;
}
