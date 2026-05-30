// Converts a git remote into a github.com web URL, or null when it is not a GitHub remote.
export function githubWebUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const s = remote.trim();
  const patterns = [
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i,
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return `https://github.com/${m[1]}/${m[2]}`;
  }
  return null;
}

// Returns the "owner/repo" slug for a GitHub remote, or null when it is not a GitHub remote.
// Used to query gh explicitly with `-R owner/repo` (deterministic; never infers a fork's upstream).
export function githubRepoSlug(remote: string | null | undefined): string | null {
  const url = githubWebUrl(remote);
  return url ? url.replace(/^https:\/\/github\.com\//, "") : null;
}
