# Contributing to Porter

## Prerequisites

- [Deno](https://deno.land/) 2.x

## Development

### Run checks

```sh
deno task check   # type checking
deno task test    # test suite
deno lint         # linting
```

### Build a standalone binary

```sh
deno task compile
```

This produces a `porter` executable in the project root.

## Submitting Changes

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run `deno task check` and `deno task test` to verify
5. Open a pull request against `main`

## Adding a Collaboration Pattern

Patterns are JSON-LD definitions -- adding one requires no code changes.

### As a built-in pattern

1. Create a `.jsonld` file following the `PatternDefinition` schema (see `docs/collaboration-patterns.md` for the full format). Include the inline `@context`, set `@type` to `"Pattern"`, and give it a unique `@id` of the form `porter:pattern/<id>`.
2. Place the file in `src/orchestration/patterns/`.
3. Add the filename to the `builtins` array in `src/orchestration/pattern_registry.ts` (the registry prefers `.jsonld` over `.json`).
4. Add an example config in `examples/`.
5. Add tests in `test/patterns_test.ts` (see "Test Structure" below).

### As a custom pattern (no code changes needed)

Custom patterns can be created entirely at runtime:

- **Via the UI:** Open the Patterns panel, click "New Pattern", use the visual editor to define roles and connections, then save. The editor generates the `bus_flow` string from your topology automatically.
- **Via upload:** Write a `.jsonld` file and upload it through the Patterns panel.
- **Via API:** `POST /api/patterns` with the pattern definition as the request body.

See `docs/collaboration-patterns.md` for the full pattern definition format, bus_flow syntax, and SHACL validation rules.

## Adding Pattern-Specific Tools

Pattern-specific tools are auto-injected at runtime via a role's `auto_tools` array. To add a new coordination tool:

1. Implement the tool handler (input validation, graph read/write).
2. Register it in the runtime tool registry.
3. Reference the tool name in the pattern definition's `auto_tools` array for the appropriate role.
4. If the tool should participate in the inference engine's intent classification, add regex patterns to the `INTENT_SIGNALS` array in `src/tools/inference_engine.ts` and follow-up chains to `FOLLOW_UP_MAP`.

Existing auto-injected tools and their roles:

| Tool | Used By | Purpose |
|------|---------|---------|
| `finding_write` | Mixture Specialist | Record findings to graph |
| `findings_query` | Mixture Synthesizer | Query all findings from graph |
| `critique_write` | Deliberation Reflector | Write critique to graph |
| `critiques_query` | Deliberation Worker | Read critiques from graph |
| `approve` | Deliberation Reflector | End deliberation loop |
| `plan_write` | Distillation Expert | Write plan steps to graph |
| `plan_query` | Distillation Learner | Read next pending step |
| `step_update` | Distillation Learner | Mark step done/failed |

## The Linked Data Model

Porter represents agents, teams, and patterns as RDF resources using the `porter:` vocabulary (`https://porter.chapeaux.io/vocab#`).

### JSON-LD Contexts

Two JSON-LD contexts define the vocabulary mappings:

- **`src/orchestration/patterns/context.jsonld`** -- Pattern vocabulary: `Pattern`, `PatternRole`, `busFlow`, `hasRole`, `minCount`, `maxCount`, `autoTool`, `subscribesTo`, etc.
- **`src/agents/context.jsonld`** -- Agent vocabulary: `Agent`, `name`, `agentExpertise`, `usesModel`, `hasTool`, `reasoning`, `maxTokens`, `visibility`, `derivedFrom`, `linkedFrom`.

### Turtle Serialization

Agents and teams are serialized as Turtle for Solid Pod storage (`src/ui/sync/sync-helpers.js`):

- `agentToTurtle(agent, uri)` -- Produces `porter:Agent` with `porter:name`, `porter:assignedRole`, `porter:agentExpertise`, `porter:hasTool`, `porter:subscribesTo`, `porter:usesModel`, etc.
- `teamToTurtle(team, uri)` -- Produces `porter:Team` with `porter:name`, `porter:teamPattern`, `porter:hasAgentRef` (blank nodes), and `porter:configJson` for lossless round-tripping.

### SHACL Shapes

`src/orchestration/patterns/pattern-shapes.ttl` defines SHACL shapes for `porter:Pattern` and `porter:PatternRole`, enforcing required properties and cardinality on save.

### JSON-LD Conversion

`src/orchestration/pattern_registry.ts` provides `patternToJsonLd()` and `jsonLdToPattern()` for converting between the internal `PatternDefinition` type and JSON-LD documents. The parser handles both inline-context short names (`roles`, `min`, `max`) and external-context full names (`hasRole`, `minCount`, `maxCount`).

## Test Structure

The test suite currently has **312 tests** across 23 test files in `test/`.

### Running tests

```sh
deno task test                    # all tests
deno test test/patterns_test.ts   # pattern tests only
```

### Pattern tests

Pattern-specific tests are in `test/patterns_test.ts`. When adding a pattern, test:

- Registration and retrieval via `getPattern()` and `listPatterns()`
- Team composition validation via `validateTeamComposition()` (both valid and invalid cases)
- Min/max enforcement for each role
- JSON-LD round-tripping via `patternToJsonLd()` and `jsonLdToPattern()`
- Composition summary via `getCompositionSummary()`

### Test file conventions

- Test files are named `*_test.ts` in the `test/` directory
- Use `Deno.test()` with descriptive names
- Import `resetPatternRegistry()` for test isolation when testing pattern registry state
- Tests run in parallel by default

## Code Style

- Follow existing patterns in the codebase
- No comments unless they explain *why*, not *what*
