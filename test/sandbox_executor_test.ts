/**
 * Tests for the container sandbox executor.
 *
 * These tests require a container runtime (podman or docker) to be available.
 * Tests are automatically skipped if no runtime is detected.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import {
  ContainerSandbox,
  ContainerSandboxHandle,
  detectRuntime,
  type ContainerRuntime,
} from "../src/sandbox/executor.ts";

// ---------------------------------------------------------------------------
// Check if a container runtime is available before running tests
// ---------------------------------------------------------------------------

let runtimeAvailable = false;
let detectedRuntime: ContainerRuntime = "podman";
try {
  detectedRuntime = await detectRuntime();
  runtimeAvailable = true;
} catch {
  // No runtime available — tests will be skipped
}

// ---------------------------------------------------------------------------
// detectRuntime()
// ---------------------------------------------------------------------------

Deno.test({
  name: "detectRuntime: finds podman or docker",
  ignore: !runtimeAvailable,
  fn() {
    assertEquals(
      detectedRuntime === "podman" || detectedRuntime === "docker",
      true,
      `Expected "podman" or "docker", got "${detectedRuntime}"`,
    );
  },
});

// ---------------------------------------------------------------------------
// ContainerSandbox — full lifecycle tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "ContainerSandbox: start creates a running container",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    await Deno.writeTextFile(`${tmpDir}/hello.txt`, "world");

    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-start",
    );
    try {
      await sandbox.start();
      assertEquals(sandbox.running, true);

      // Verify container can read a mounted file
      const result = await sandbox.exec(["cat", "/workspace/hello.txt"]);
      assertEquals(result.stdout.trim(), "world");
      assertEquals(result.success, true);
    } finally {
      await sandbox.stop();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ContainerSandbox: exec echo returns stdout",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-echo",
    );
    try {
      await sandbox.start();

      const result = await sandbox.exec(["echo", "hello"]);
      assertEquals(result.stdout.trim(), "hello");
      assertEquals(result.success, true);
      assertEquals(result.code, 0);
    } finally {
      await sandbox.stop();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ContainerSandbox: exec reads mounted workspace file",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    await Deno.writeTextFile(`${tmpDir}/hello.txt`, "world");

    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-read-file",
    );
    try {
      await sandbox.start();

      const result = await sandbox.exec(["cat", "/workspace/hello.txt"]);
      assertEquals(result.stdout.trim(), "world");
      assertEquals(result.success, true);
    } finally {
      await sandbox.stop();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ContainerSandbox: exec sees container /home, not host /home",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-no-host-home",
    );
    try {
      await sandbox.start();

      // ls /home should succeed but NOT show the host user's home directory
      const result = await sandbox.exec(["ls", "/home"]);
      assertEquals(result.success, true);
      // The host user's home should not appear in the container's /home
      assertEquals(result.stdout.includes("ldary"), false);
    } finally {
      await sandbox.stop();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ContainerSandbox: host SSH keys are not accessible",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-no-ssh",
    );
    try {
      await sandbox.start();

      const result = await sandbox.exec(["cat", "/root/.ssh/id_rsa"]);
      assertEquals(result.success, false);
    } finally {
      await sandbox.stop();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ContainerSandbox: exec passes environment variables",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-env",
    );
    try {
      await sandbox.start();

      const result = await sandbox.exec(["env"], { env: { FOO: "bar" } });
      assertEquals(result.success, true);
      assertStringIncludes(result.stdout, "FOO=bar");
    } finally {
      await sandbox.stop();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ContainerSandbox: exec with cwd translates host paths",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    await Deno.mkdir(`${tmpDir}/subdir`);

    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-cwd",
    );
    try {
      await sandbox.start();

      // Pass a host-style path — should be translated to /workspace/subdir
      const result = await sandbox.exec(["pwd"], {
        cwd: `${tmpDir}/subdir`,
      });
      assertEquals(result.success, true);
      assertEquals(result.stdout.trim(), "/workspace/subdir");
    } finally {
      await sandbox.stop();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ContainerSandbox: stop removes container and sets running to false",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-stop",
    );
    try {
      await sandbox.start();
      assertEquals(sandbox.running, true);

      await sandbox.stop();
      assertEquals(sandbox.running, false);

      // Verify the container no longer exists
      const cmd = new Deno.Command(detectedRuntime, {
        args: ["inspect", sandbox.containerName],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      assertEquals(result.success, false, "Container should not exist after stop");
    } finally {
      // Ensure cleanup even if assertions fail
      try {
        await sandbox.stop();
      } catch { /* already stopped */ }
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// ContainerSandboxHandle — shared container tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "ContainerSandboxHandle: exec works with an already-running container",
  ignore: !runtimeAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
    await Deno.writeTextFile(`${tmpDir}/shared.txt`, "shared-content");

    // Start a container using the full sandbox
    const sandbox = new ContainerSandbox(
      { enabled: true },
      tmpDir,
      "test-handle",
    );
    try {
      await sandbox.start();

      // Create a handle that references the same container
      const handle = new ContainerSandboxHandle(
        sandbox.runtime,
        sandbox.containerName,
        tmpDir,
      );

      assertEquals(handle.running, true);
      assertEquals(handle.runtime, sandbox.runtime);

      const result = await handle.exec(["cat", "/workspace/shared.txt"]);
      assertEquals(result.stdout.trim(), "shared-content");
      assertEquals(result.success, true);
    } finally {
      await sandbox.stop();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "ContainerSandboxHandle: start() throws — lifecycle not owned",
  ignore: !runtimeAvailable,
  async fn() {
    const handle = new ContainerSandboxHandle(
      detectedRuntime,
      "nonexistent-container",
      "/tmp",
    );

    await assertRejects(
      () => handle.start(),
      Error,
      "does not own the container lifecycle",
    );
  },
});

Deno.test({
  name: "ContainerSandboxHandle: stop() throws — lifecycle not owned",
  ignore: !runtimeAvailable,
  async fn() {
    const handle = new ContainerSandboxHandle(
      detectedRuntime,
      "nonexistent-container",
      "/tmp",
    );

    await assertRejects(
      () => handle.stop(),
      Error,
      "does not own the container lifecycle",
    );
  },
});
