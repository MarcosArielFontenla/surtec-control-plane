const CORE_ENVIRONMENT = new Set([
  "APPDATA", "COMSPEC", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH", "PATHEXT",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP",
  "TERM", "TMP", "USERPROFILE", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
]);

const GITHUB_CLI_AUTH_ENVIRONMENT = [
  "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITHUB_TOKEN",
];
const GIT_NETWORK_AUTH_ENVIRONMENT = ["GIT_CONFIG_GLOBAL", "SSH_AUTH_SOCK"];
const CODEX_APP_SERVER_ENVIRONMENT = new Set([
  "APPDATA", "CODEX_HOME", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LOCALAPPDATA", "NO_PROXY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_PROJECT", "PATH", "PATHEXT",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SSL_CERT_DIR", "SSL_CERT_FILE", "SYSTEMROOT",
  "TEMP", "TMP", "USERPROFILE", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
]);

function normalizedNames(names) {
  return new Set([...names].map((name) => name.trim().toUpperCase()).filter(Boolean));
}

export function allowlistedEnvironment(source = process.env, extraNames = []) {
  const allowed = normalizedNames([...CORE_ENVIRONMENT, ...extraNames]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())));
}

export function localGitEnvironment(source = process.env) {
  // Local inspection must never inherit service credentials or arbitrary Git overrides.
  return allowlistedEnvironment(source);
}

export function githubCliEnvironment(source = process.env) {
  return allowlistedEnvironment(source, GITHUB_CLI_AUTH_ENVIRONMENT);
}

export function gitNetworkEnvironment(source = process.env) {
  // Network Git relies on the user's configured credential helper or SSH agent, not raw tokens.
  return {
    ...allowlistedEnvironment(source, GIT_NETWORK_AUTH_ENVIRONMENT),
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function projectCommandEnvironment(source = process.env) {
  const configured = (source.SURTEC_RUN_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return allowlistedEnvironment(source, configured);
}

export function codexAppServerEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => CODEX_APP_SERVER_ENVIRONMENT.has(key.toUpperCase())),
  );
}

export function systemProcessEnvironment(source = process.env) {
  return allowlistedEnvironment(source);
}

export function openActionEnvironment(source = process.env) {
  return allowlistedEnvironment(source);
}
