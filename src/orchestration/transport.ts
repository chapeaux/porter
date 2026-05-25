/**
 * Transport abstraction for tmux operations.
 *
 * LocalTransport runs tmux commands directly. RemoteTransport (future)
 * wraps them in `oc exec`.
 */

/** Information about a tmux pane. */
export interface PaneInfo {
  /** Pane ID (e.g. %0, %1). */
  id: string;
  /** Pane index within the window. */
  index: number;
  /** Window index. */
  window: number;
  /** Whether this pane is active. */
  active: boolean;
  /** Pane title if set. */
  title: string;
}

/** Common interface for tmux transports. */
export interface Transport {
  /** Create a new tmux session. */
  newSession(name: string): Promise<void>;
  /** Kill a tmux session. */
  killSession(name: string): Promise<void>;
  /** Check if a session exists. */
  hasSession(name: string): Promise<boolean>;
  /** Create a new pane by splitting the current window. Returns the pane ID. */
  spawnPane(session: string, title?: string): Promise<string>;
  /** Create a new window in the session. Returns the pane ID of the new window. */
  spawnWindow(session: string, name?: string): Promise<string>;
  /** Send text to a specific pane. */
  sendKeys(paneId: string, text: string): Promise<void>;
  /** Set the pane title. */
  setPaneTitle(paneId: string, title: string): Promise<void>;
  /** List all panes in a session. */
  listPanes(session: string): Promise<PaneInfo[]>;
  /** Respawn a dead pane. */
  respawnPane(paneId: string): Promise<void>;
  /** Kill a specific pane. */
  killPane(paneId: string): Promise<void>;
  /** Send a command to a pane and press enter. */
  sendCommand(paneId: string, command: string): Promise<void>;
  /** Style a pane's border with a color and label. */
  stylePaneBorder(paneId: string, color: string, label: string): Promise<void>;
  /** Configure the session to show pane borders with titles. */
  enablePaneTitles(session: string): Promise<void>;
}

/**
 * Run a command and return stdout. Throws on non-zero exit.
 */
async function exec(
  cmd: string,
  args: string[],
): Promise<string> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`${cmd} ${args.join(" ")} failed: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * Run a command, ignoring failures (for optional operations).
 */
async function execQuiet(cmd: string, args: string[]): Promise<void> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "null",
    stderr: "null",
  });
  await command.output();
}

/**
 * Local tmux transport -- runs tmux commands directly.
 */
export class LocalTransport implements Transport {
  async newSession(name: string): Promise<void> {
    await exec("tmux", ["new-session", "-d", "-s", name, "-x", "200", "-y", "50"]);
  }

  async killSession(name: string): Promise<void> {
    await execQuiet("tmux", ["kill-session", "-t", name]);
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await exec("tmux", ["has-session", "-t", name]);
      return true;
    } catch {
      return false;
    }
  }

  async spawnPane(session: string, title?: string): Promise<string> {
    const paneId = await exec("tmux", [
      "split-window",
      "-t",
      session,
      "-P",
      "-F",
      "#{pane_id}",
    ]);

    // Re-tile so panes are evenly distributed
    await execQuiet("tmux", ["select-layout", "-t", session, "tiled"]);

    if (title) {
      await this.setPaneTitle(paneId, title);
    }

    return paneId;
  }

  async spawnWindow(session: string, name?: string): Promise<string> {
    const args = [
      "new-window",
      "-t", session,
      "-P", "-F", "#{pane_id}",
    ];
    if (name) {
      args.push("-n", name);
    }
    return await exec("tmux", args);
  }

  async sendKeys(paneId: string, text: string): Promise<void> {
    await exec("tmux", ["send-keys", "-t", paneId, text, ""]);
  }

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    await exec("tmux", [
      "select-pane",
      "-t",
      paneId,
      "-T",
      title,
    ]);
  }

  async listPanes(session: string): Promise<PaneInfo[]> {
    try {
      const output = await exec("tmux", [
        "list-panes",
        "-t",
        session,
        "-a",
        "-F",
        "#{pane_id}\t#{pane_index}\t#{window_index}\t#{pane_active}\t#{pane_title}",
      ]);

      return output.split("\n").filter(Boolean).map((line) => {
        const [id, index, window, active, title] = line.split("\t");
        return {
          id,
          index: parseInt(index),
          window: parseInt(window),
          active: active === "1",
          title: title ?? "",
        };
      });
    } catch {
      return [];
    }
  }

  async respawnPane(paneId: string): Promise<void> {
    await exec("tmux", ["respawn-pane", "-k", "-t", paneId]);
  }

  async killPane(paneId: string): Promise<void> {
    await execQuiet("tmux", ["kill-pane", "-t", paneId]);
  }

  async sendCommand(paneId: string, command: string): Promise<void> {
    await exec("tmux", ["send-keys", "-t", paneId, command, "Enter"]);
  }

  async stylePaneBorder(paneId: string, color: string, label: string): Promise<void> {
    // Set the pane border style color
    await execQuiet("tmux", [
      "select-pane", "-t", paneId,
      "-P", `fg=${color}`,
    ]);
    // Set pane border color
    await execQuiet("tmux", [
      "set-option", "-p", "-t", paneId,
      "pane-border-style", `fg=${color}`,
    ]);
    await execQuiet("tmux", [
      "set-option", "-p", "-t", paneId,
      "pane-active-border-style", `fg=${color},bold`,
    ]);
    // Set the pane title (shown in border)
    await this.setPaneTitle(paneId, label);
  }

  async enablePaneTitles(session: string): Promise<void> {
    // Show pane borders with titles
    await execQuiet("tmux", [
      "set-option", "-t", session, "pane-border-status", "top",
    ]);
    // Format: show pane title in the border
    await execQuiet("tmux", [
      "set-option", "-t", session, "pane-border-format",
      " #{pane_title} ",
    ]);
    // Set default border colors (overridden per-pane)
    await execQuiet("tmux", [
      "set-option", "-t", session, "pane-border-style", "fg=colour240",
    ]);
    await execQuiet("tmux", [
      "set-option", "-t", session, "pane-active-border-style", "fg=colour250,bold",
    ]);
  }
}

/**
 * Remote transport -- wraps tmux commands in `oc exec`.
 */
export class RemoteTransport implements Transport {
  constructor(
    private pod: string,
    private namespace: string,
  ) {}

  private async ocExec(args: string[]): Promise<string> {
    return await exec("oc", [
      "exec",
      this.pod,
      "-n",
      this.namespace,
      "--",
      ...args,
    ]);
  }

  async newSession(name: string): Promise<void> {
    await this.ocExec(["tmux", "new-session", "-d", "-s", name]);
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.ocExec(["tmux", "kill-session", "-t", name]);
    } catch { /* session may not exist */ }
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.ocExec(["tmux", "has-session", "-t", name]);
      return true;
    } catch {
      return false;
    }
  }

  async spawnPane(session: string, title?: string): Promise<string> {
    const paneId = await this.ocExec([
      "tmux", "split-window", "-t", session, "-P", "-F", "#{pane_id}",
    ]);
    if (title) await this.setPaneTitle(paneId, title);
    return paneId;
  }

  async spawnWindow(session: string, name?: string): Promise<string> {
    const args = ["tmux", "new-window", "-t", session, "-P", "-F", "#{pane_id}"];
    if (name) args.push("-n", name);
    return await this.ocExec(args);
  }

  async sendKeys(paneId: string, text: string): Promise<void> {
    await this.ocExec(["tmux", "send-keys", "-t", paneId, text, ""]);
  }

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    await this.ocExec(["tmux", "select-pane", "-t", paneId, "-T", title]);
  }

  async listPanes(session: string): Promise<PaneInfo[]> {
    try {
      const output = await this.ocExec([
        "tmux", "list-panes", "-t", session, "-a", "-F",
        "#{pane_id}\t#{pane_index}\t#{window_index}\t#{pane_active}\t#{pane_title}",
      ]);
      return output.split("\n").filter(Boolean).map((line) => {
        const [id, index, window, active, title] = line.split("\t");
        return {
          id,
          index: parseInt(index),
          window: parseInt(window),
          active: active === "1",
          title: title ?? "",
        };
      });
    } catch {
      return [];
    }
  }

  async respawnPane(paneId: string): Promise<void> {
    await this.ocExec(["tmux", "respawn-pane", "-k", "-t", paneId]);
  }

  async killPane(paneId: string): Promise<void> {
    try {
      await this.ocExec(["tmux", "kill-pane", "-t", paneId]);
    } catch { /* pane may already be gone */ }
  }

  async sendCommand(paneId: string, command: string): Promise<void> {
    await this.ocExec(["tmux", "send-keys", "-t", paneId, command, "Enter"]);
  }

  async stylePaneBorder(paneId: string, color: string, label: string): Promise<void> {
    await this.ocExec(["tmux", "set-option", "-p", "-t", paneId, "pane-border-style", `fg=${color}`]);
    await this.ocExec(["tmux", "set-option", "-p", "-t", paneId, "pane-active-border-style", `fg=${color},bold`]);
    await this.ocExec(["tmux", "select-pane", "-t", paneId, "-T", label]);
  }

  async enablePaneTitles(session: string): Promise<void> {
    await this.ocExec(["tmux", "set-option", "-t", session, "pane-border-status", "top"]);
    await this.ocExec(["tmux", "set-option", "-t", session, "pane-border-format", " #{pane_title} "]);
  }
}

/**
 * Null transport for headless/in-cluster operation.
 * All tmux operations are no-ops. Agent output goes to logs only.
 */
export class NullTransport implements Transport {
  private paneCounter = 0;

  async newSession(_name: string): Promise<void> {}
  async killSession(_name: string): Promise<void> {}
  async hasSession(_name: string): Promise<boolean> { return false; }

  async spawnPane(_session: string, _title?: string): Promise<string> {
    return `%${this.paneCounter++}`;
  }

  async spawnWindow(_session: string, _name?: string): Promise<string> {
    return `%${this.paneCounter++}`;
  }

  async sendKeys(_paneId: string, _text: string): Promise<void> {}
  async setPaneTitle(_paneId: string, _title: string): Promise<void> {}

  async listPanes(_session: string): Promise<PaneInfo[]> {
    return [{ id: "%0", index: 0, window: 0, active: true, title: "" }];
  }

  async respawnPane(_paneId: string): Promise<void> {}
  async killPane(_paneId: string): Promise<void> {}
  async sendCommand(_paneId: string, _command: string): Promise<void> {}
  async stylePaneBorder(_paneId: string, _color: string, _label: string): Promise<void> {}
  async enablePaneTitles(_session: string): Promise<void> {}
}
