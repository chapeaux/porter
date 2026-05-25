/**
 * Tests for runtime tool registry -- validation and init container generation.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  validateToolSpec,
  buildToolInitContainers,
  TOOL_REGISTRY,
} from "../src/router/tool_registry.ts";

Deno.test("runtime_tool_registry", async (t) => {
  await t.step("validateToolSpec resolves known short name", () => {
    const spec = validateToolSpec("python3");
    assertEquals(spec.name, "python3");
    assertEquals(spec.image, "registry.access.redhat.com/ubi9/python-311:latest");
    assertEquals(spec.binPath, "/usr/bin/python3");
  });

  await t.step("validateToolSpec rejects unknown short name", () => {
    assertThrows(
      () => validateToolSpec("nmap"),
      Error,
      "Unknown runtime tool: 'nmap'",
    );
  });

  await t.step("validateToolSpec accepts custom entry from allowed registry", () => {
    const spec = validateToolSpec({
      name: "ruby",
      image: "registry.access.redhat.com/ubi9/ruby-32:latest",
      binPath: "/usr/bin/ruby",
    });
    assertEquals(spec.name, "ruby");
    assertEquals(spec.image, "registry.access.redhat.com/ubi9/ruby-32:latest");
  });

  await t.step("validateToolSpec accepts custom entry from quay.io", () => {
    const spec = validateToolSpec({
      name: "custom",
      image: "quay.io/myorg/mytool:1.0",
      binPath: "/usr/bin/custom",
    });
    assertEquals(spec.name, "custom");
    assertEquals(spec.image, "quay.io/myorg/mytool:1.0");
  });

  await t.step("validateToolSpec rejects custom entry from disallowed registry", () => {
    assertThrows(
      () =>
        validateToolSpec({
          name: "evil",
          image: "docker.io/malicious/tool:latest",
          binPath: "/usr/bin/evil",
        }),
      Error,
      "Image registry not allowed",
    );
  });

  await t.step("validateToolSpec rejects custom entry missing name", () => {
    assertThrows(
      () =>
        validateToolSpec({ name: "", image: "quay.io/foo:1", binPath: "/bin/foo" }),
      Error,
      "requires",
    );
  });

  await t.step("validateToolSpec rejects custom entry missing image", () => {
    assertThrows(
      () =>
        validateToolSpec({ name: "foo", image: "", binPath: "/bin/foo" }),
      Error,
      "requires",
    );
  });

  await t.step("validateToolSpec rejects custom entry missing binPath", () => {
    assertThrows(
      () =>
        validateToolSpec({ name: "foo", image: "quay.io/foo:1", binPath: "" }),
      Error,
      "requires",
    );
  });

  await t.step("buildToolInitContainers produces correct specs", () => {
    const result = buildToolInitContainers(["python3", "curl"]);

    assertEquals(result.initContainers.length, 2);
    assertEquals(result.initContainers[0].name, "tool-python3");
    assertEquals(
      result.initContainers[0].image,
      "registry.access.redhat.com/ubi9/python-311:latest",
    );
    assertEquals(result.initContainers[0].command, [
      "cp",
      "/usr/bin/python3",
      "/porter/tools/python3",
    ]);

    assertEquals(result.initContainers[1].name, "tool-curl");

    assertEquals(result.volumes.length, 1);
    assertEquals(result.volumes[0].name, "porter-tools");

    assertEquals(result.volumeMounts.length, 1);
    assertEquals(result.volumeMounts[0].mountPath, "/porter/tools");

    assertEquals(result.env.length, 1);
    assertEquals(result.env[0].name, "PATH");
  });

  await t.step(
    "buildToolInitContainers handles mixed short names and custom entries",
    () => {
      const result = buildToolInitContainers([
        "jq",
        {
          name: "ruby",
          image: "registry.access.redhat.com/ubi9/ruby-32:latest",
          binPath: "/usr/bin/ruby",
        },
      ]);
      assertEquals(result.initContainers.length, 2);
      assertEquals(result.initContainers[0].name, "tool-jq");
      assertEquals(result.initContainers[1].name, "tool-ruby");
      assertEquals(
        result.initContainers[1].image,
        "registry.access.redhat.com/ubi9/ruby-32:latest",
      );
    },
  );

  await t.step("buildToolInitContainers fails if any tool is invalid", () => {
    assertThrows(
      () => buildToolInitContainers(["python3", "nmap"]),
      Error,
      "Unknown runtime tool",
    );
  });

  await t.step("buildToolInitContainers volume mounts on init containers", () => {
    const result = buildToolInitContainers(["curl"]);
    assertEquals(result.initContainers[0].volumeMounts.length, 1);
    assertEquals(result.initContainers[0].volumeMounts[0].name, "porter-tools");
    assertEquals(
      result.initContainers[0].volumeMounts[0].mountPath,
      "/porter/tools",
    );
  });

  await t.step("all registry entries have valid image paths", () => {
    for (const [name, entry] of Object.entries(TOOL_REGISTRY)) {
      assertEquals(
        typeof entry.image,
        "string",
        `${name} image should be string`,
      );
      assertEquals(
        typeof entry.binPath,
        "string",
        `${name} binPath should be string`,
      );
      assertEquals(
        entry.image.startsWith("registry.access.redhat.com/"),
        true,
        `${name} should use redhat registry`,
      );
      assertEquals(
        entry.binPath.startsWith("/"),
        true,
        `${name} binPath should be absolute`,
      );
    }
  });
});
