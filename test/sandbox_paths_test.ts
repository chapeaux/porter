import {
  assertEquals,
  assertRejects,
} from "@std/assert";
import { PathEscapeError, validatePath } from "../src/sandbox/paths.ts";

Deno.test("validatePath - relative path within workspace", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await Deno.mkdir(`${workspace}/src`, { recursive: true });
    await Deno.writeTextFile(`${workspace}/src/app.ts`, "// app");

    const result = await validatePath("src/app.ts", workspace);
    assertEquals(result, `${await Deno.realPath(workspace)}/src/app.ts`);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - absolute path within workspace", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await Deno.mkdir(`${workspace}/src`, { recursive: true });
    await Deno.writeTextFile(`${workspace}/src/app.ts`, "// app");

    const absPath = `${workspace}/src/app.ts`;
    const result = await validatePath(absPath, workspace);
    assertEquals(result, `${await Deno.realPath(workspace)}/src/app.ts`);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - absolute path outside workspace throws", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await assertRejects(
      () => validatePath("/etc/passwd", workspace),
      PathEscapeError,
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - traversal attack throws", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await assertRejects(
      () => validatePath("../../etc/passwd", workspace),
      PathEscapeError,
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - symlink escape throws", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await Deno.symlink("/etc", `${workspace}/link`);

    await assertRejects(
      () => validatePath("link/passwd", workspace),
      PathEscapeError,
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - nonexistent file in valid dir passes", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await Deno.mkdir(`${workspace}/src`, { recursive: true });

    const result = await validatePath("src/newfile.ts", workspace);
    assertEquals(result, `${await Deno.realPath(workspace)}/src/newfile.ts`);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - null bytes throw", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await assertRejects(
      () => validatePath("foo\0bar", workspace),
      PathEscapeError,
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - empty path throws", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await assertRejects(
      () => validatePath("", workspace),
      PathEscapeError,
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - workspace root via dot", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    const result = await validatePath(".", workspace);
    assertEquals(result, await Deno.realPath(workspace));
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("validatePath - dot-dot at boundary does not false-positive", async () => {
  // Create two sibling dirs: workspace and workspace-evil.
  // Ensure that "../workspace-evil" from inside workspace is rejected,
  // and that a sibling whose name is a string prefix of workspace
  // (e.g. workspace-evil starts with workspace name) is also rejected.
  const parent = await Deno.makeTempDir({ prefix: "porter-sandbox-parent-" });
  const workspace = `${parent}/workspace`;
  const sibling = `${parent}/workspace-evil`;
  await Deno.mkdir(workspace);
  await Deno.mkdir(sibling);
  try {
    // Traversal to a sibling directory must be rejected
    await assertRejects(
      () => validatePath("../workspace-evil", workspace),
      PathEscapeError,
    );

    // Also verify an absolute path to the sibling is rejected
    await assertRejects(
      () => validatePath(sibling, workspace),
      PathEscapeError,
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("validatePath - nested traversal throws", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "porter-sandbox-test-" });
  try {
    await Deno.mkdir(`${workspace}/src`, { recursive: true });

    await assertRejects(
      () => validatePath("src/../../../etc/passwd", workspace),
      PathEscapeError,
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});
