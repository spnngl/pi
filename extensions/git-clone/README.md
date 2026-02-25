# git-clone Extension

A pi extension that provides a `git_clone` tool, allowing the LLM to automatically clone git repositories into a structured local directory.

## Directory layout

Repositories are cloned to:

```text
~/src/<registry>/<path...>/<name>/
```

Examples:

| URL                                                | Local path                                       |
| -------------------------------------------------- | ------------------------------------------------ |
| `git@github.com:user/repo.git`                     | `~/src/github.com/user/repo`                     |
| `git@gitlab.com:devops/services-configuration.git` | `~/src/gitlab.com/devops/services-configuration` |
| `https://github.com/user/repo.git`                 | `~/src/github.com/user/repo`                     |

## Supported URL formats

| Format       | Example                            |
| ------------ | ---------------------------------- |
| SSH          | `git@gitlab.com:devops/repo.git`   |
| HTTPS        | `https://github.com/user/repo.git` |
| Git protocol | `git://github.com/user/repo.git`   |

## Behaviour

-   **Repository absent** → `git clone <url> <target>` (creates parent directories as needed)
-   **Repository present** → `git pull` to update
-   **Authentication** → handled externally by the user (ssh-agent, Git credential helper, etc.)

## Tool parameters

| Parameter | Type    | Required | Description                                       |
| --------- | ------- | -------- | ------------------------------------------------- |
| `url`     | string  | ✓        | Full git URL                                      |
| `branch`  | string  |          | Branch or tag to checkout (default: repo default) |
| `shallow` | boolean |          | Shallow clone with `--depth 1`                    |

## Installation

### Global (all projects)

```bash
# Symlink or copy the directory
ln -s /path/to/extensions/git-clone ~/.pi/agent/extensions/git-clone
```

### Project-local

```bash
# Symlink or copy the directory
ln -s /path/to/extensions/git-clone .pi/extensions/git-clone
```

Then run `npm install` inside the extension directory.
