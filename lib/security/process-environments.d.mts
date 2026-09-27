export type ProcessEnvironment = NodeJS.ProcessEnv;

export function allowlistedEnvironment(source?: ProcessEnvironment, extraNames?: Iterable<string>): ProcessEnvironment;
export function localGitEnvironment(source?: ProcessEnvironment): ProcessEnvironment;
export function githubCliEnvironment(source?: ProcessEnvironment): ProcessEnvironment;
export function gitNetworkEnvironment(source?: ProcessEnvironment): ProcessEnvironment;
export function projectCommandEnvironment(source?: ProcessEnvironment): ProcessEnvironment;
export function codexAppServerEnvironment(source?: ProcessEnvironment): ProcessEnvironment;
export function systemProcessEnvironment(source?: ProcessEnvironment): ProcessEnvironment;
export function openActionEnvironment(source?: ProcessEnvironment): ProcessEnvironment;
