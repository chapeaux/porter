import { assertEquals } from "jsr:@std/assert";

import readFile, { setWorkingDir as setReadWorkingDir } from "../src/tools/read_file.ts";
import writeFile, { setWorkingDir as setWriteWorkingDir } from "../src/tools/write_file.ts";
import editFile, { setWorkingDir as setEditWorkingDir } from "../src/tools/edit_file.ts";
import glob, { setWorkingDir as setGlobWorkingDir } from "../src/tools/glob.ts";
import grep, { setWorkingDir as setGrepWorkingDir } from "../src/tools/grep.ts";
import listDir, { setWorkingDir as setListDirWorkingDir } from "../src/tools/list_dir.ts";

// ── read_file ────────────────────────────────────────────────────────

Deno.test("read_file rejects paths outside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setReadWorkingDir(workspace);
    const result = await readFile.execute({ path: "/etc/passwd" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setReadWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("read_file allows valid path inside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${workspace}/test.txt`, "hello");
    setReadWorkingDir(workspace);
    const result = await readFile.execute({ path: `${workspace}/test.txt` });
    assertEquals(result.is_error, undefined);
    assertEquals(result.content.includes("hello"), true);
  } finally {
    setReadWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("read_file rejects traversal paths", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setReadWorkingDir(workspace);
    const result = await readFile.execute({ path: "../../etc/passwd" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setReadWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

// ── write_file ───────────────────────────────────────────────────────

Deno.test("write_file rejects paths outside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setWriteWorkingDir(workspace);
    const result = await writeFile.execute({ path: "/tmp/evil.txt", content: "bad" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setWriteWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("write_file allows valid path inside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setWriteWorkingDir(workspace);
    const result = await writeFile.execute({ path: `${workspace}/out.txt`, content: "ok" });
    assertEquals(result.is_error, undefined);
    const text = await Deno.readTextFile(`${workspace}/out.txt`);
    assertEquals(text, "ok");
  } finally {
    setWriteWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("write_file rejects traversal paths", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setWriteWorkingDir(workspace);
    const result = await writeFile.execute({ path: `${workspace}/../../etc/evil`, content: "bad" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setWriteWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

// ── edit_file ────────────────────────────────────────────────────────

Deno.test("edit_file rejects paths outside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setEditWorkingDir(workspace);
    const result = await editFile.execute({
      path: "/etc/passwd",
      old_string: "root",
      new_string: "toor",
    });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setEditWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("edit_file allows valid path inside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${workspace}/edit.txt`, "hello world");
    setEditWorkingDir(workspace);
    const result = await editFile.execute({
      path: `${workspace}/edit.txt`,
      old_string: "hello",
      new_string: "goodbye",
    });
    assertEquals(result.is_error, undefined);
    const text = await Deno.readTextFile(`${workspace}/edit.txt`);
    assertEquals(text, "goodbye world");
  } finally {
    setEditWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("edit_file rejects traversal paths", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setEditWorkingDir(workspace);
    const result = await editFile.execute({
      path: "../../etc/passwd",
      old_string: "root",
      new_string: "toor",
    });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setEditWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

// ── glob ─────────────────────────────────────────────────────────────

Deno.test("glob rejects paths outside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setGlobWorkingDir(workspace);
    const result = await glob.execute({ pattern: "*", path: "/etc" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setGlobWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("glob allows valid path inside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${workspace}/file.ts`, "");
    setGlobWorkingDir(workspace);
    const result = await glob.execute({ pattern: "*.ts", path: workspace });
    assertEquals(result.is_error, undefined);
    assertEquals(result.content.includes("file.ts"), true);
  } finally {
    setGlobWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("glob rejects traversal paths", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setGlobWorkingDir(workspace);
    const result = await glob.execute({ pattern: "*", path: `${workspace}/../../etc` });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setGlobWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

// ── grep ─────────────────────────────────────────────────────────────

Deno.test("grep rejects paths outside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setGrepWorkingDir(workspace);
    const result = await grep.execute({ pattern: "root", path: "/etc/passwd" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setGrepWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("grep allows valid path inside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${workspace}/search.txt`, "hello world\nfoo bar");
    setGrepWorkingDir(workspace);
    const result = await grep.execute({ pattern: "hello", path: `${workspace}/search.txt` });
    assertEquals(result.is_error, undefined);
    assertEquals(result.content.includes("hello world"), true);
  } finally {
    setGrepWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("grep rejects traversal paths", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setGrepWorkingDir(workspace);
    const result = await grep.execute({ pattern: "root", path: "../../etc/passwd" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setGrepWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

// ── list_dir ─────────────────────────────────────────────────────────

Deno.test("list_dir rejects paths outside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setListDirWorkingDir(workspace);
    const result = await listDir.execute({ path: "/etc" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setListDirWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("list_dir allows valid path inside workspace", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${workspace}/item.txt`, "");
    setListDirWorkingDir(workspace);
    const result = await listDir.execute({ path: workspace });
    assertEquals(result.is_error, undefined);
    assertEquals(result.content.includes("item.txt"), true);
  } finally {
    setListDirWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("list_dir rejects traversal paths", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    setListDirWorkingDir(workspace);
    const result = await listDir.execute({ path: "../../etc" });
    assertEquals(result.is_error, true);
    assertEquals(result.content.includes("outside the workspace"), true);
  } finally {
    setListDirWorkingDir(null);
    await Deno.remove(workspace, { recursive: true });
  }
});
