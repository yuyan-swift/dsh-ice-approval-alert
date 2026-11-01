# Security

## What this plugin accesses

- DOM: it observes `[data-approval-key]` nodes to know when an approval card appears or disappears.
- `localStorage`: it stores only the on/off setting and volume under `dsh.ice-approval-alert.v1`.
- Web Audio: it synthesizes the sound locally. No audio files are downloaded.

## What it does not do

- No network requests.
- No upload of approval text, prompts, commands, credentials, or session data.
- No file-system access, process spawning, or command execution.
- No modification of the approval request or its result.

## Reporting

If you find a security issue, please open a private report through GitHub Security Advisories on this repository, or contact the maintainer through GitHub.
