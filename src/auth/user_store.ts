/**
 * Persistent team and session storage per user.
 *
 * Teams are saved porter.json configurations that can be restored
 * across logins. Stored as plain JSON files under ~/.porter/users/{sub}/teams/.
 */

import { dirname } from "jsr:@std/path@^1";
import type { PorterConfig } from "../core/config.ts";

export interface SavedTeam {
  name: string;
  config: PorterConfig;
  created_at: string;
  updated_at: string;
}

export interface SavedAgent {
  name: string;
  role: string;
  model?: string;
  system_prompt: string;
  prompt_sections?: { id: string; title: string; content: string; default?: string }[];
  tools: string[];
  channels: string[];
  mcp_tools: string[];
  max_tokens: number;
  reasoning: boolean;
  _context?: string;
  visibility?: "private" | "shared";
  author?: string;
  created_at: string;
  updated_at: string;
}

function teamsDir(userId: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/users/${userId}/teams`;
}

function teamPath(userId: string, name: string): string {
  // Sanitize name to prevent path traversal
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${teamsDir(userId)}/${safe}.json`;
}

function agentsDir(userId: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/users/${userId}/agents`;
}

function agentPath(userId: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${agentsDir(userId)}/${safe}.json`;
}

function snapshotsDir(userId: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/users/${userId}/sessions`;
}

export class UserStore {
  async listTeams(userId: string): Promise<SavedTeam[]> {
    const dir = teamsDir(userId);
    const teams: SavedTeam[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          try {
            const text = await Deno.readTextFile(`${dir}/${entry.name}`);
            teams.push(JSON.parse(text) as SavedTeam);
          } catch {
            // Skip corrupt files
          }
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return teams.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getTeam(userId: string, name: string): Promise<SavedTeam | null> {
    const path = teamPath(userId, name);
    try {
      const text = await Deno.readTextFile(path);
      return JSON.parse(text) as SavedTeam;
    } catch {
      return null;
    }
  }

  async saveTeam(userId: string, team: SavedTeam): Promise<void> {
    const path = teamPath(userId, team.name);
    const dir = dirname(path);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(team, null, 2));
  }

  async deleteTeam(userId: string, name: string): Promise<boolean> {
    const path = teamPath(userId, name);
    try {
      await Deno.remove(path);
      return true;
    } catch {
      return false;
    }
  }

  async listAgents(userId: string): Promise<SavedAgent[]> {
    const dir = agentsDir(userId);
    const agents: SavedAgent[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          try {
            const text = await Deno.readTextFile(`${dir}/${entry.name}`);
            agents.push(JSON.parse(text) as SavedAgent);
          } catch { /* skip corrupt */ }
        }
      }
    } catch { /* dir doesn't exist */ }
    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getAgent(userId: string, name: string): Promise<SavedAgent | null> {
    try {
      const text = await Deno.readTextFile(agentPath(userId, name));
      return JSON.parse(text) as SavedAgent;
    } catch { return null; }
  }

  async saveAgent(userId: string, agent: SavedAgent): Promise<void> {
    const path = agentPath(userId, agent.name);
    const dir = dirname(path);
    await Deno.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    if (!agent.created_at) agent.created_at = now;
    agent.updated_at = now;
    await Deno.writeTextFile(path, JSON.stringify(agent, null, 2));
  }

  async deleteAgent(userId: string, name: string): Promise<boolean> {
    try { await Deno.remove(agentPath(userId, name)); return true; }
    catch { return false; }
  }

  async listSnapshots(userId: string): Promise<string[]> {
    const dir = snapshotsDir(userId);
    const snapshots: string[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          snapshots.push(entry.name.replace(/\.json$/, ""));
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return snapshots.sort();
  }
}
