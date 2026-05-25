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

## Code Style

- Follow existing patterns in the codebase
- No comments unless they explain *why*, not *what*
