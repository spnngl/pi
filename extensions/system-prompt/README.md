# System Prompt Extension

A simple extension that allows you to print the current system prompt used by the assistant.

## Features

-   **Tool**: `print_system_prompt` - The LLM can call this tool to retrieve and display its own system prompt
-   **Command**: `/system-prompt` - Quick command to print the system prompt directly without going through the LLM

## Installation

```bash
cd extensions/system-prompt
npm install
```

## Usage

Load the extension with pi:

```bash
pi -e ./extensions/system-prompt
```

Then either:

-   Ask the LLM to "print your system prompt" or "show me your instructions"
-   Use the command `/system-prompt` directly
