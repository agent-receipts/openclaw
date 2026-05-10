#!/usr/bin/env bash
#
# scripts/release.sh — Automate the openclaw release flow
#
# Usage:
#   scripts/release.sh [--dry-run] <patch|minor|major|X.Y.Z[-prerelease]>
#
# Steps:
#   1. Validate preconditions (clean tree, on main, required tools present)
#   2. Compute new version
#   3. Promote CHANGELOG.md [Unreleased] to a versioned entry
#   4. Bump package.json
#   5. Commit, tag, and push
#   6. Create GitHub Release — triggers publish.yml → npm publish
set -euo pipefail

cd "$(dirname "$0")/.." || { echo "error: cannot change to repo root" >&2; exit 1; }

# ── Usage ─────────────────────────────────────────────────────────────────────

usage() {
  echo "Usage: $(basename "$0") [--dry-run] <patch|minor|major|X.Y.Z[-prerelease]>" >&2
  echo >&2
  echo "  patch|minor|major        Bump the current version by that increment (stable only)" >&2
  echo "  X.Y.Z[-prerelease]       Use this exact version" >&2
  echo "  --dry-run                Print every step; make no changes" >&2
  exit 1
}

# ── Arguments ─────────────────────────────────────────────────────────────────

DRY_RUN=false
BUMP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -*)        usage ;;
    *)
      [[ -n "$BUMP" ]] && usage
      BUMP="$arg"
      ;;
  esac
done

[[ -z "$BUMP" ]] && usage

# ── Helpers ───────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

# Validate a version string: must match SEMVER_RE and must not contain purely
# numeric pre-release identifiers with leading zeros (SemVer §9).
# Usage: validate_semver <version> <context>
validate_semver() {
  local v="$1" ctx="$2"
  [[ "$v" =~ $SEMVER_RE ]] \
    || die "${ctx} '${v}' is not a valid SemVer version (X.Y.Z or X.Y.Z-prerelease)"
  if [[ "$v" == *-* ]]; then
    local pre="${v#*-}" id
    IFS='.' read -ra _ids <<< "$pre"
    for id in "${_ids[@]}"; do
      [[ "$id" =~ ^0[0-9]+$ ]] \
        && die "invalid pre-release identifier '${id}' in '${ctx}' '${v}' — numeric identifiers must not have leading zeros"
    done
  fi
}

# run <cmd> [args...] — execute normally, or just print in dry-run mode
run() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run]" "$@"
  else
    "$@"
  fi
}

# ── Preconditions ─────────────────────────────────────────────────────────────

for tool in gh git node npm; do
  command -v "$tool" &>/dev/null || die "'$tool' not found in PATH"
done

gh auth status &>/dev/null || die "gh is not authenticated — run 'gh auth login' first"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" ]] || die "must be on main branch (currently on '$BRANCH')"

[[ -z "$(git status --porcelain)" ]] \
  || die "working tree is not clean — commit, stash, or remove untracked files first"

run git pull --ff-only

# Guard: ensure no unpushed commits will sneak into the release push
if [[ "$DRY_RUN" == false ]]; then
  AHEAD=$(git rev-list --count "origin/main..HEAD")
  [[ "$AHEAD" -eq 0 ]] || die "local main is ${AHEAD} commit(s) ahead of origin/main — push first"
fi

# ── Compute new version ───────────────────────────────────────────────────────

CURRENT_VERSION=$(node -p "require('./package.json').version")

SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z][0-9A-Za-z-]*(\.[0-9A-Za-z][0-9A-Za-z-]*)*)?$'
validate_semver "$CURRENT_VERSION" "package.json version"

# Extract the stable X.Y.Z base and detect whether we're currently on a pre-release
CURRENT_BASE="${CURRENT_VERSION%%-*}"
IS_PRERELEASE=false
[[ "$CURRENT_VERSION" != "$CURRENT_BASE" ]] && IS_PRERELEASE=true

IFS='.' read -r VER_MAJOR VER_MINOR VER_PATCH <<< "$CURRENT_BASE"

case "$BUMP" in
  patch|minor|major)
    [[ "$IS_PRERELEASE" == true ]] \
      && die "'${BUMP}' bump is not defined for pre-release version '${CURRENT_VERSION}' — specify an explicit version (e.g. '${CURRENT_BASE}' to promote to stable, or '${CURRENT_BASE}-alpha.2' for the next pre-release)"
    case "$BUMP" in
      patch) NEW_VERSION="${VER_MAJOR}.${VER_MINOR}.$((VER_PATCH + 1))" ;;
      minor) NEW_VERSION="${VER_MAJOR}.$((VER_MINOR + 1)).0" ;;
      major) NEW_VERSION="$((VER_MAJOR + 1)).0.0" ;;
    esac
    ;;
  *)
    validate_semver "$BUMP" "version argument"
    NEW_VERSION="$BUMP"
    ;;
esac

# Guard: new version must be strictly greater than current (SemVer-aware).
# Bash arithmetic can't handle pre-release suffixes; use Node for the comparison.
export NEW_VERSION CURRENT_VERSION
node << 'JSEOF'
function parse(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) { process.stderr.write('error: invalid version: ' + v + '\n'); process.exit(2); }
  // Purely numeric pre-release identifiers must not have leading zeros (SemVer §9)
  if (m[4]) {
    for (const id of m[4].split('.')) {
      if (/^\d+$/.test(id) && id.length > 1 && id[0] === '0') {
        process.stderr.write("error: invalid pre-release identifier '" + id + "' in '" + v + "' — numeric identifiers must not have leading zeros\n");
        process.exit(1);
      }
    }
  }
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}
// Compare two dot-separated pre-release identifiers per SemVer §11.4
function comparePre(a, b) {
  const ap = a.split('.'), bp = b.split('.');
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    if (i >= ap.length) return -1; // fewer identifiers = lower precedence
    if (i >= bp.length) return 1;
    const ai = ap[i], bi = bp[i];
    const an = /^\d+$/.test(ai), bn = /^\d+$/.test(bi);
    if (an && bn) { if (ai !== bi) return BigInt(ai) > BigInt(bi) ? 1 : -1; }
    else if (an !== bn) { return an ? -1 : 1; } // numeric < alphanumeric
    else { if (ai < bi) return -1; if (ai > bi) return 1; }
  }
  return 0;
}
function cmp(a, b) {
  const pa = parse(a), pb = parse(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;   // release > pre-release of same X.Y.Z
  if (pb.pre === null) return -1;  // pre-release < release of same X.Y.Z
  return comparePre(pa.pre, pb.pre);
}
const nv = process.env.NEW_VERSION, cv = process.env.CURRENT_VERSION;
if (cmp(nv, cv) <= 0) {
  process.stderr.write("error: version '" + nv + "' must be strictly greater than current '" + cv + "'\n");
  process.exit(1);
}
JSEOF

TAG="v${NEW_VERSION}"
RELEASE_DATE=$(date -u +%Y-%m-%d)

# Detect whether the new version is a pre-release
IS_NEW_PRERELEASE=false
[[ "${NEW_VERSION}" == *-* ]] && IS_NEW_PRERELEASE=true

echo "current: ${CURRENT_VERSION}"
echo "    new: ${NEW_VERSION}  (${TAG})"
[[ "$DRY_RUN" == true ]] && echo "(dry-run — no changes will be made)"
echo

if git rev-parse "$TAG" &>/dev/null; then
  die "tag '${TAG}' already exists"
fi

# ── Update CHANGELOG.md ───────────────────────────────────────────────────────

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] CHANGELOG.md: add '## [${NEW_VERSION}] - ${RELEASE_DATE}' and update reference links"
else
  export NEW_VERSION RELEASE_DATE
  node << 'JSEOF'
const fs = require('fs');
const src = fs.readFileSync('CHANGELOG.md', 'utf8');
const { NEW_VERSION, RELEASE_DATE } = process.env;

// Promote [Unreleased] heading to a versioned entry; fresh empty [Unreleased] inserted above
let out = src.replace(
  /^## \[Unreleased\]/m,
  `## [Unreleased]\n\n## [${NEW_VERSION}] - ${RELEASE_DATE}`,
);
if (out === src) {
  process.stderr.write('error: CHANGELOG.md has no "## [Unreleased]" section\n');
  process.exit(1);
}

// Update Keep-a-Changelog reference links at the bottom.
// The previous version may itself be a pre-release (e.g. v0.8.0-alpha.1),
// so match any non-whitespace chars after /compare/v rather than only X.Y.Z.
const linkMatch = out.match(/^\[Unreleased\]:\s*(\S+?)\/compare\/v(\S+?)\.\.\.HEAD\s*$/m);
if (linkMatch) {
  const [fullMatch, repoUrl, prevVersion] = linkMatch;
  out = out.replace(
    fullMatch,
    `[Unreleased]: ${repoUrl}/compare/v${NEW_VERSION}...HEAD\n[${NEW_VERSION}]: ${repoUrl}/compare/v${prevVersion}...v${NEW_VERSION}`,
  );
}

fs.writeFileSync('CHANGELOG.md', out);
JSEOF
fi

# ── Bump package.json ─────────────────────────────────────────────────────────

run npm version "$NEW_VERSION" --no-git-tag-version

# ── Commit, tag, push ─────────────────────────────────────────────────────────

run git add CHANGELOG.md package.json
run git commit -m "chore(release): ${TAG}"
run git tag "$TAG"
run git push origin main "$TAG"

# ── Create GitHub Release ─────────────────────────────────────────────────────

# If this step fails, the tag is already pushed. Retry with:
#   gh release create "$TAG" --title "$TAG" --generate-notes [--prerelease]
if [[ "$IS_NEW_PRERELEASE" == true ]]; then
  run gh release create "$TAG" \
    --title "$TAG" \
    --generate-notes \
    --prerelease
else
  run gh release create "$TAG" \
    --title "$TAG" \
    --generate-notes
fi

echo
echo "Done. ${TAG} is live — publish.yml will handle npm publishing."
