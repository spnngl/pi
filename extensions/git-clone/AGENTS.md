# git-clone Extension

## Purpose

Provides the `git_clone` tool. The LLM calls it to clone or update a repository in `~/src/<registry>/<path>/<name>`.

## When to call `git_clone`

Call it proactively whenever a task requires a repository that is not yet present locally:

-   User references a repository by URL → clone it, then continue the task
-   A file or directory path under `~/src/` is needed but does not exist → clone the repo first
-   User says "get", "fetch", "clone", or "pull" a repository

Do **not** ask the user to clone manually if you can call the tool yourself.

## After cloning

The tool returns the absolute local path in the `content` text (`Cloned: /home/.../src/...`). Use that path immediately for subsequent file reads, searches, or edits.

## Authentication

Authentication is fully handled by the user's environment (ssh-agent, `.netrc`, Git credential helper). Do not prompt the user for credentials.
