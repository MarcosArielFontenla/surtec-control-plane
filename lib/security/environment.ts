const CORE_ENVIRONMENT = new Set([
  "APPDATA", "COMSPEC", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH", "PATHEXT",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP",
  "TERM", "TMP", "USERPROFILE", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
]);

const GIT_AUTH_ENVIRONMENT = ["GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"];

function normalizedNames(names: Iterable<string>): Set<string> {
  return new Set([...names].map((name) => name.trim().toUpperCase()).filter(Boolean));
}

export function allowlistedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extraNames: Iterable<string> = [],
): NodeJS.ProcessEnv {
  const allowed = normalizedNames([...CORE_ENVIRONMENT, ...extraNames]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())));
}

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return allowlistedEnvironment(source, GIT_AUTH_ENVIRONMENT);
}

export function projectCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const configured = (source.SURTEC_RUN_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return allowlistedEnvironment(source, configured);
}

