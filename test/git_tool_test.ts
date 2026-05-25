/**
 * Tests for tools/git.ts — allowlist enforcement, cwd injection, error handling.
 * Tests for tools/bash.ts — cwd injection.
 *
 * Git tests initialize a temporary git repository to avoid depending on
 * whether the working directory itself is a git repo.
 */

import { assertEquals, assertStringIncludes, assertExists } from "jsr:@std/assert";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Initialize a bare temp git repository and return its path. */
async function makeTempGitRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "porter-git-test-" });
  const init = new Deno.Command("git", {
    args: ["init"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await init.output();
  if (!out.success) {
    throw new Error(
      `git init failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return dir;
}

// Load tools (top-level await is fine in ES modules)
const gitTool = (await import("../src/tools/git.ts")).default;
const bashTool = (await import("../src/tools/bash.ts")).default;

// ---------------------------------------------------------------------------
// 1. Tool definition / schema
// ---------------------------------------------------------------------------

Deno.test("git tool: definition has correct name", () => {
  assertEquals(gitTool.definition.name, "git");
});

Deno.test("git tool: input_schema has required object structure", () => {
  const schema = gitTool.definition.input_schema as Record<string, unknown>;
  assertEquals(schema.type, "object");
  const props = schema.properties as Record<string, unknown>;
  assertExists(props.command);
  assertExists(props.args);
  assertExists(props.cwd);
  const required = schema.required as string[];
  assertEquals(required.includes("command"), true);
  // args and cwd are optional
  assertEquals(required.includes("args"), false);
  assertEquals(required.includes("cwd"), false);
});

Deno.test("bash tool: definition has correct name", () => {
  assertEquals(bashTool.definition.name, "bash");
});

Deno.test("bash tool: input_schema requires command", () => {
  const schema = bashTool.definition.input_schema as Record<string, unknown>;
  assertEquals(schema.type, "object");
  const required = schema.required as string[];
  assertEquals(required.includes("command"), true);
});

// ---------------------------------------------------------------------------
// 2. Allowlist enforcement
// ---------------------------------------------------------------------------

Deno.test("git tool: rejects disallowed subcommand 'gc'", async () => {
  const result = await gitTool.execute({ command: "gc" });
  assertEquals(result.is_error, true);
  assertStringIncludes(result.content, "not allowed");
  assertStringIncludes(result.content, "gc");
});

Deno.test("git tool: rejects disallowed subcommand 'clean'", async () => {
  const result = await gitTool.execute({ command: "clean" });
  assertEquals(result.is_error, true);
  assertStringIncludes(result.content, "not allowed");
});

Deno.test("git tool: rejects disallowed subcommand 'bisect'", async () => {
  const result = await gitTool.execute({ command: "bisect" });
  assertEquals(result.is_error, true);
  assertStringIncludes(result.content, "not allowed");
});

Deno.test("git tool: rejects disallowed subcommand 'reflog'", async () => {
  const result = await gitTool.execute({ command: "reflog" });
  assertEquals(result.is_error, true);
  assertStringIncludes(result.content, "not allowed");
});

Deno.test("git tool: error message lists allowed subcommands", async () => {
  const result = await gitTool.execute({ command: "format-patch" });
  assertEquals(result.is_error, true);
  // Should mention several known allowed commands in the error
  assertStringIncludes(result.content, "status");
  assertStringIncludes(result.content, "log");
  assertStringIncludes(result.content, "diff");
});

// ---------------------------------------------------------------------------
// 3. Allowed subcommands with cwd injection
// ---------------------------------------------------------------------------

Deno.test("git tool: allows 'status' in a git repo", async () => {
  const repoDir = await makeTempGitRepo();
  try {
    const result = await gitTool.execute({ command: "status", cwd: repoDir });
    // No error — status works on any git repo
    assertEquals(result.is_error, undefined);
    // Git status always mentions a branch
    assertStringIncludes(result.content.toLowerCase(), "branch");
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("git tool: allows 'rev-parse --is-inside-work-tree'", async () => {
  const repoDir = await makeTempGitRepo();
  try {
    const result = await gitTool.execute({
      command: "rev-parse",
      args: ["--is-inside-work-tree"],
      cwd: repoDir,
    });
    assertEquals(result.is_error, undefined);
    assertStringIncludes(result.content.trim(), "true");
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("git tool: allows 'branch' listing in fresh repo", async () => {
  const repoDir = await makeTempGitRepo();
  try {
    const result = await gitTool.execute({
      command: "branch",
      args: ["-a"],
      cwd: repoDir,
    });
    // A fresh repo may have no branches yet — either way, not an allowlist error
    assertEquals(
      result.is_error === true &&
        result.content.includes("not allowed"),
      false,
      "branch should not be an allowlist rejection",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("git tool: allows 'log' (may fail with no commits)", async () => {
  const repoDir = await makeTempGitRepo();
  try {
    const result = await gitTool.execute({
      command: "log",
      args: ["--oneline", "-3"],
      cwd: repoDir,
    });
    // A fresh repo has no commits — git log exits non-zero, but the subcommand
    // is allowed (not an allowlist rejection).
    // If it errors, the error should mention commits, not "not allowed"
    if (result.is_error) {
      const notAllowlistError = !result.content.includes("not allowed");
      assertEquals(notAllowlistError, true);
    } else {
      // If there are commits, content should be non-empty
      assertEquals(result.content.length > 0, true);
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("git tool: 'status' reports error for non-git directory", async () => {
  // A plain temp dir (not a git repo) should produce a git error
  const tmpDir = await Deno.makeTempDir({ prefix: "porter-nongit-" });
  try {
    const result = await gitTool.execute({ command: "status", cwd: tmpDir });
    // Git errors (non-zero exit) are surfaced as is_error: true
    assertEquals(result.is_error, true);
    // Should mention "not a git repository"
    assertStringIncludes(result.content.toLowerCase(), "not a git repository");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("git tool: allows 'diff' in a repo", async () => {
  const repoDir = await makeTempGitRepo();
  try {
    const result = await gitTool.execute({ command: "diff", cwd: repoDir });
    // diff with no commits/changes just outputs nothing — not an error
    assertEquals(result.is_error === true && result.content.includes("not allowed"), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("git tool: allows 'remote -v' in a repo", async () => {
  const repoDir = await makeTempGitRepo();
  try {
    const result = await gitTool.execute({
      command: "remote",
      args: ["-v"],
      cwd: repoDir,
    });
    // No remotes in a fresh repo — but the command is allowed
    assertEquals(result.is_error === true && result.content.includes("not allowed"), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Content output format
// ---------------------------------------------------------------------------

Deno.test("git tool: empty output returns '(no output)' placeholder", async () => {
  const repoDir = await makeTempGitRepo();
  try {
    // `git diff` on a fresh repo with no changes produces no output
    const result = await gitTool.execute({ command: "diff", cwd: repoDir });
    if (!result.is_error) {
      assertEquals(result.content, "(no output)");
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("git tool: error output includes exit code", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "porter-nongit-" });
  try {
    const result = await gitTool.execute({ command: "status", cwd: tmpDir });
    assertEquals(result.is_error, true);
    assertStringIncludes(result.content, "Exit code:");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 5. bash tool — cwd injection
// ---------------------------------------------------------------------------

Deno.test("bash tool: cwd parameter changes working directory", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "porter-bash-test-" });
  try {
    const result = await bashTool.execute({ command: "pwd", cwd: tmpDir });
    assertEquals(result.is_error, undefined);
    // The resolved real path should be contained in the output
    // (tmpDir itself may have symlinks on macOS)
    const realTmp = await Deno.realPath(tmpDir);
    assertStringIncludes(result.content.trim(), realTmp);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("bash tool: can create and read files in specified cwd", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "porter-bash-test-" });
  try {
    const writeResult = await bashTool.execute({
      command: "echo hello > test.txt && cat test.txt",
      cwd: tmpDir,
    });
    assertEquals(writeResult.is_error, undefined);
    assertStringIncludes(writeResult.content, "hello");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("bash tool: captures stderr on failure", async () => {
  const result = await bashTool.execute({ command: "cat /nonexistent_file_xyz" });
  assertEquals(result.is_error, true);
  assertStringIncludes(result.content, "Exit code:");
});

Deno.test("bash tool: successful command returns is_error undefined", async () => {
  const result = await bashTool.execute({ command: "echo ok" });
  assertEquals(result.is_error, undefined);
  assertStringIncludes(result.content, "ok");
});
