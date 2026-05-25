import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Import tools directly
import readFile from "../src/tools/read_file.ts";
import writeFile from "../src/tools/write_file.ts";
import editFile from "../src/tools/edit_file.ts";
import bash from "../src/tools/bash.ts";
import glob from "../src/tools/glob.ts";
import grep from "../src/tools/grep.ts";
import listDir from "../src/tools/list_dir.ts";

const TEST_DIR = await Deno.makeTempDir({ prefix: "porter-test-" });

Deno.test("read_file - reads file with line numbers", async () => {
  const path = `${TEST_DIR}/read_test.txt`;
  await Deno.writeTextFile(path, "line one\nline two\nline three");

  const result = await readFile.execute({ path });
  assertEquals(result.is_error, undefined);
  assertStringIncludes(result.content, "1\tline one");
  assertStringIncludes(result.content, "2\tline two");
  assertStringIncludes(result.content, "3\tline three");
});

Deno.test("read_file - offset and limit", async () => {
  const path = `${TEST_DIR}/read_offset.txt`;
  await Deno.writeTextFile(path, "a\nb\nc\nd\ne");

  const result = await readFile.execute({ path, offset: 1, limit: 2 });
  assertEquals(result.is_error, undefined);
  assertStringIncludes(result.content, "2\tb");
  assertStringIncludes(result.content, "3\tc");
});

Deno.test("read_file - returns error for missing file", async () => {
  const result = await readFile.execute({ path: `${TEST_DIR}/nonexistent` });
  assertEquals(result.is_error, true);
});

Deno.test("write_file - creates file with content", async () => {
  const path = `${TEST_DIR}/write_test.txt`;
  const result = await writeFile.execute({ path, content: "hello\nworld" });

  assertEquals(result.is_error, undefined);
  const text = await Deno.readTextFile(path);
  assertEquals(text, "hello\nworld");
});

Deno.test("write_file - creates parent directories", async () => {
  const path = `${TEST_DIR}/sub/dir/file.txt`;
  const result = await writeFile.execute({ path, content: "nested" });

  assertEquals(result.is_error, undefined);
  const text = await Deno.readTextFile(path);
  assertEquals(text, "nested");
});

Deno.test("edit_file - replaces string", async () => {
  const path = `${TEST_DIR}/edit_test.txt`;
  await Deno.writeTextFile(path, "hello world, hello everyone");

  // "hello world" is unique, so this should work
  const result = await editFile.execute({
    path,
    old_string: "hello world",
    new_string: "goodbye world",
  });

  assertEquals(result.is_error, undefined);
  const text = await Deno.readTextFile(path);
  assertStringIncludes(text, "goodbye world");
  assertStringIncludes(text, "hello everyone");
});

Deno.test("edit_file - errors on non-unique string without replace_all", async () => {
  const path = `${TEST_DIR}/edit_dup.txt`;
  await Deno.writeTextFile(path, "foo bar foo baz");

  const result = await editFile.execute({
    path,
    old_string: "foo",
    new_string: "qux",
  });
  assertEquals(result.is_error, true);
});

Deno.test("edit_file - replace_all works", async () => {
  const path = `${TEST_DIR}/edit_all.txt`;
  await Deno.writeTextFile(path, "foo bar foo baz");

  const result = await editFile.execute({
    path,
    old_string: "foo",
    new_string: "qux",
    replace_all: true,
  });

  assertEquals(result.is_error, undefined);
  const text = await Deno.readTextFile(path);
  assertEquals(text, "qux bar qux baz");
});

Deno.test("bash - executes command", async () => {
  const result = await bash.execute({ command: "echo hello" });
  assertEquals(result.is_error, undefined);
  assertStringIncludes(result.content, "hello");
});

Deno.test("bash - captures stderr on failure", async () => {
  const result = await bash.execute({ command: "echo err >&2 && exit 1" });
  assertEquals(result.is_error, true);
  assertStringIncludes(result.content, "err");
});

Deno.test("glob - finds files", async () => {
  await Deno.writeTextFile(`${TEST_DIR}/glob_a.ts`, "");
  await Deno.writeTextFile(`${TEST_DIR}/glob_b.ts`, "");
  await Deno.writeTextFile(`${TEST_DIR}/glob_c.json`, "");

  const result = await glob.execute({ pattern: "*.ts", path: TEST_DIR });
  assertEquals(result.is_error, undefined);
  assertStringIncludes(result.content, "glob_a.ts");
  assertStringIncludes(result.content, "glob_b.ts");
});

Deno.test("grep - searches file contents", async () => {
  await Deno.writeTextFile(`${TEST_DIR}/grep_target.txt`, "hello world\nfoo bar\nhello again");

  const result = await grep.execute({ pattern: "hello", path: TEST_DIR + "/grep_target.txt" });
  assertEquals(result.is_error, undefined);
  assertStringIncludes(result.content, "hello world");
  assertStringIncludes(result.content, "hello again");
});

Deno.test("grep - case insensitive", async () => {
  await Deno.writeTextFile(`${TEST_DIR}/grep_case.txt`, "Hello World\nfoo bar");

  const result = await grep.execute({
    pattern: "hello",
    path: TEST_DIR + "/grep_case.txt",
    case_insensitive: true,
  });
  assertEquals(result.is_error, undefined);
  assertStringIncludes(result.content, "Hello World");
});

Deno.test("list_dir - lists directory contents", async () => {
  const subDir = `${TEST_DIR}/listdir_test`;
  await Deno.mkdir(subDir, { recursive: true });
  await Deno.writeTextFile(`${subDir}/file.txt`, "");
  await Deno.mkdir(`${subDir}/subdir`);

  const result = await listDir.execute({ path: subDir });
  assertEquals(result.is_error, undefined);
  assertStringIncludes(result.content, "file.txt");
  assertStringIncludes(result.content, "subdir/");
});

// Cleanup
Deno.test("cleanup temp dir", async () => {
  await Deno.remove(TEST_DIR, { recursive: true });
});
