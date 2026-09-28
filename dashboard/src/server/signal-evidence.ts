import { dirname } from "node:path";
import type { GitStatus, Inbox, TaskRecord } from "../../../lib/state/types";
import { listTasks } from "../../../lib/state/store";
import { listNotes, type Note } from "../../../lib/state/notes";
import { listProjectProfiles } from "../../../lib/state/portfolio-profiles";
import { readClientPortfolio as loadClientPortfolio } from "../../../lib/state/client-portfolio";
import type { ProjectProfile } from "../../../lib/portfolio-profile";
import type { ClientPortfolioDocument } from "../../../lib/client-portfolio";
import type { ProjectIntegrationsReader } from "../../../lib/integrations/types";
import type { SignalEvidenceSnapshot } from "../../../lib/signals/engine";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";
import { assemblePortfolio } from "../../../lib/portfolio";
import { loadProjectConfig } from "./portfolio-config";
import { loadRegistryProjects } from "./registry";
import { createInboxCache, mapWithConcurrency, readInbox, type InboxCache } from "./github-inbox";
import { readGitStatus } from "../../../lib/git-status";

export interface SignalEvidenceReader {
  read(): Promise<SignalEvidenceSnapshot>;
}

export interface SignalEvidenceDependencies {
  integrations?: ProjectIntegrationsReader;
  inboxCache?: InboxCache;
  discover?: (root: string, ignore: string[]) => { id: string; path: string }[];
  readGit?: (path: string) => GitStatus;
  readTasks?: () => TaskRecord[];
  readProfiles?: () => ProjectProfile[];
  readClientPortfolio?: () => ClientPortfolioDocument;
  readNotes?: (projectId: string) => Note[];
  readInbox?: () => Promise<Inbox>;
  readRegisteredProjects?: () => { id: string; repo: string | null }[];
  root?: string;
  concurrency?: number;
}

function latestActivity(tasks: TaskRecord[], git: GitStatus | null): string | null {
  const dates = [
    ...tasks.map((task) => task.updated_at),
    ...(git?.last_commit?.at ? [git.last_commit.at] : []),
  ].filter((value) => Number.isFinite(Date.parse(value)));
  return dates.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

export function createSignalEvidenceReader(repoRoot: string, dependencies: SignalEvidenceDependencies = {}): SignalEvidenceReader {
  const root = dependencies.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((value) => value.trim()).filter(Boolean)];
  const discover = dependencies.discover ?? discoverProjects;
  const readGit = dependencies.readGit ?? readGitStatus;
  const readTasks = dependencies.readTasks ?? listTasks;
  const readProfiles = dependencies.readProfiles ?? listProjectProfiles;
  const readClientPortfolio = dependencies.readClientPortfolio ?? loadClientPortfolio;
  const readNotes = dependencies.readNotes ?? listNotes;
  const inboxCache = dependencies.inboxCache ?? createInboxCache();
  const readInboxSnapshot = dependencies.readInbox ?? (() => inboxCache.get("inbox", () => readInbox(repoRoot)));
  const readRegisteredProjects = dependencies.readRegisteredProjects ?? (() => loadRegistryProjects(repoRoot));
  const concurrency = dependencies.concurrency ?? 4;

  return {
    async read(): Promise<SignalEvidenceSnapshot> {
      const warnings: string[] = [];
      let tasks: TaskRecord[] = [];
      let profiles: ProjectProfile[] = [];
      let clientPortfolio: ClientPortfolioDocument = { schema_version: 1, clients: {}, commitments: {} };
      let profilesAvailable = true;
      let discovered: { id: string; path: string }[] = [];
      let inbox: Inbox = { items: [], repos: [] };
      let registered: { id: string; repo: string | null }[] = [];
      try { tasks = readTasks(); } catch { warnings.push("Task evidence could not be read; other signal sources remain available."); }
      try { profiles = readProfiles(); } catch { profilesAvailable = false; warnings.push("Portfolio profiles could not be read; other signal sources remain available."); }
      try { clientPortfolio = readClientPortfolio(); } catch { warnings.push("Client commitment evidence could not be read; other signal sources remain available."); }
      try { discovered = discover(root, ignore); } catch { warnings.push("Project discovery failed; other signal sources remain available."); }
      try { inbox = await readInboxSnapshot(); } catch { warnings.push("GitHub issue evidence could not be read; other signal sources remain available."); }
      try { registered = readRegisteredProjects(); } catch { warnings.push("Integration registry could not be read; local signal sources remain available."); }

      const statusByPath = new Map<string, GitStatus>();
      for (const project of discovered) {
        try {
          const status = readGit(project.path);
          statusByPath.set(project.path, status);
          if (!status.ok) warnings.push(`Local Git evidence for project ${project.id} is unavailable.`);
        }
        catch { warnings.push(`Local Git evidence for project ${project.id} is unavailable.`); }
      }
      const portfolio = assemblePortfolio(discovered, statusByPath, loadProjectConfig(repoRoot));
      const profileById = new Map(profiles.map((profile) => [profile.project_id, profile]));
      const discoveredProjectIds = new Set(portfolio.map((project) => project.id));
      const tasksByProject = new Map<string, TaskRecord[]>();
      for (const task of tasks) {
        const bucket = tasksByProject.get(task.envelope.project) ?? [];
        bucket.push(task);
        tasksByProject.set(task.envelope.project, bucket);
      }

      const integrationsById = new Map<string, Awaited<ReturnType<ProjectIntegrationsReader["read"]>>>();
      if (dependencies.integrations) {
        const perProject = await mapWithConcurrency(registered, concurrency, async (project) => {
          try { return { id: project.id, value: await dependencies.integrations!.read(project.id) }; }
          catch { warnings.push(`Integration evidence for project ${project.id} is unavailable.`); return null; }
        });
        for (const item of perProject) if (item) integrationsById.set(item.id, item.value);
      }

      for (const repo of inbox.repos) {
        if (!repo.ok) warnings.push(`GitHub issue evidence for project ${repo.id} is unavailable.`);
      }
      const projects = portfolio.map((project) => {
        const projectTasks = tasksByProject.get(project.id) ?? [];
        let notes: Note[] = [];
        try { notes = readNotes(project.id); }
        catch { warnings.push(`Project note evidence for project ${project.id} is unavailable.`); }
        return {
          id: project.id,
          status: project.status,
          git: project.git,
          profile: profileById.get(project.id) ?? null,
          profile_available: profilesAvailable,
          integrations: integrationsById.get(project.id) ?? null,
          last_activity_at: latestActivity(projectTasks, project.git),
          notes,
        };
      });
      const commitments = Object.values(clientPortfolio.commitments).filter((commitment) => {
        if (!discoveredProjectIds.has(commitment.project_id)) return false;
        if (!commitment.client_id) return true;
        const linkedClient = clientPortfolio.clients[commitment.client_id];
        const profile = profileById.get(commitment.project_id);
        if (!linkedClient || profile?.kind !== "client" || profile.client_id !== linkedClient.id) {
          warnings.push("One or more client commitment associations are invalid; those signals were omitted.");
          return false;
        }
        return true;
      }).map((commitment) => ({
        id: commitment.id,
        project_id: commitment.project_id,
        client_id: commitment.client_id,
        title: commitment.title,
        due_date: commitment.due_date,
        priority: commitment.priority,
        criticality: commitment.criticality,
        state: commitment.state,
        next_action: commitment.next_action,
        updated_at: commitment.updated_at,
      }));
      return { projects, tasks, issues: inbox.items, sessions: [], commitments, warnings: [...new Set(warnings)].slice(0, 50) };
    },
  };
}
