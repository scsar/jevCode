// Environment for the agent and the sandboxed verification commands (design 5.x: "pass only the
// names a run needs; never copy credentials"). Everything else in the parent environment, such as
// TYPESAFE_API_KEY or other API keys, stays out.
//
// Codex and Claude Code sign in from files under the user profile, so no API key is needed by
// default. To pass extra names on purpose (e.g. a provider used with an API key), list them in
// JEVCODE_ENV_PASS, comma-separated; listed names are passed as they are.

// Names Windows programs, git, node, dotnet and PowerShell expect.
const NAMES = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'OS',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'PSModulePath', 'LANG', 'TZ',
  // Agent configuration locations (not credentials) and the host's network proxy.
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
];
// Tool settings by prefix; a name that looks like a secret is still dropped.
const PREFIXES = ['DOTNET_', 'NUGET_', 'MSBUILD', 'UNITY_'];
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

// Windows environment names are case-insensitive ("Path" and "PATH" are the same variable).
export function runEnv(source = process.env, extra = {}) {
  const wanted = new Set(NAMES.map((n) => n.toUpperCase()));
  for (const n of String(source.JEVCODE_ENV_PASS || '').split(',').map((s) => s.trim()).filter(Boolean)) wanted.add(n.toUpperCase());
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    const byPrefix = PREFIXES.some((p) => upper.startsWith(p.toUpperCase())) && !SECRET.test(name);
    if (wanted.has(upper) || byPrefix) env[name] = value;
  }
  return { ...env, ...extra };
}
