# Publication audit — 2026-09-10

Scope: the source files selected for the initial public repository, its initial
commit, and the Docker build exclusions. Private deployment data is not part of
the repository.

## Cleanup

- Removed the personal SSH username, preconfigured host, and live domain from
  source defaults, documentation, and browser tests.
- New workspaces now start empty and the administrator username is not prefilled.
- Replaced the live-host traffic/certificate browser test with a disposable local
  Docker deployment and a generated certificate for the reserved `example.test`
  domain. All browser tests use temporary accounts and state.
- Expanded Git and Docker exclusions for runtime databases, environment files,
  SSH identities, certificates, ACME storage, tokens, configuration backups,
  logs, and screenshots.
- Used a GitHub noreply address for commit attribution, rather than a private
  email address.

## Checks

- Gitleaks v8.30.1: no findings in the exact staged publication snapshot or the
  initial Git commit history. Scans use redacted output and no test-directory
  allowlist.
- Manual source review and searches for personal identifiers, live hostnames,
  private paths, and credential literals: identified references removed.
- Compared staged source against private identifiers and credential values from
  local application state without printing those values: no matches.
- Verified that the Git index contains no runtime data, credentials, screenshots,
  dependencies, or symlinks, and checked representative private-file exclusions.
- All 21 unit tests and the editor, onboarding, and traffic/certificate browser
  integration suites passed after cleanup.
- Added CI checks for unit tests and full-history secret scanning on pushes and
  pull requests.

Synthetic test passwords and example values are intentionally present. Test SSH
keys and certificates are generated at runtime and removed with their temporary
fixtures. No production credentials or deployment data are published.

This is a publication-focused audit, not a guarantee that automated scanners can
recognize every possible secret or a full application security assessment. Keep
custom data/key directories outside the checkout and never force-add runtime
files to Git.
