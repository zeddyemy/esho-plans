#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
skill_home="$HOME"
mode=link
dry_run=false
operation=install

while (($#)); do
  case "$1" in
    --copy) mode=copy ;;
    --dry-run) dry_run=true ;;
    --backup-only) operation=backup ;;
    --uninstall) operation=uninstall ;;
    --home)
      if (($# < 2)); then printf 'Missing directory for --home.\n' >&2; exit 2; fi
      skill_home="$2"
      shift
      ;;
    *)
      printf 'Usage: %s [--dry-run] [--copy | --backup-only | --uninstall] [--home <dir>]\n' "$0" >&2
      exit 2
      ;;
  esac
  shift
done

skill_home="$(cd "$skill_home" && pwd -P)"
if [[ "$skill_home" == / ]]; then printf 'Choose a specific home directory.\n' >&2; exit 2; fi
backups="$skill_home/.skill-backups"
cli="$repo_dir/cli/dist/index.js"
targets=(
  .claude/skills/adp-plan .claude/skills/adp-workflow
  .agents/skills/adp-plan .agents/skills/adp-workflow
  .local/bin/esho-plans
)

exists() { [[ -e "$1" || -L "$1" ]]; }

save_backup() {
  local directory="$1" target original saved
  for target in "${targets[@]}"; do
    original="$skill_home/$target"
    saved="$directory/$target"
    if exists "$original"; then
      mkdir -p "$(dirname "$saved")"
      cp -pPR "$original" "$saved"
      if [[ -L "$original" ]]; then
        [[ "$(readlink "$original")" == "$(readlink "$saved")" ]]
      else
        diff -r "$original" "$saved"
      fi
      printf 'Backed up %s to %s\n' "$original" "$saved"
    fi
  done
}

restore() {
  local directory="$1" target original saved
  for target in "${targets[@]}"; do
    original="$skill_home/$target"
    saved="$directory/$target"
    if "$dry_run"; then
      if exists "$saved"; then printf 'Would restore %s from %s\n' "$original" "$saved"
      else printf 'Would remove %s\n' "$original"; fi
      continue
    fi
    if exists "$original"; then
      mkdir -p "$directory/replaced/$(dirname "$target")"
      mv "$original" "$directory/replaced/$target"
    fi
    if exists "$saved"; then
      mkdir -p "$(dirname "$original")"
      cp -pPR "$saved" "$original"
      printf 'Restored %s\n' "$original"
    elif exists "$directory/replaced/$target"; then
      printf 'Removed %s\n' "$original"
    fi
  done
}

if [[ "$operation" == uninstall ]]; then
  last=""
  for directory in "$backups"/install.*; do
    if [[ -f "$directory/installed" ]]; then last="$directory"; fi
  done
  if [[ -z "$last" ]]; then printf 'No skill installation backup was found.\n' >&2; exit 1; fi
  restore "$last"
  if ! "$dry_run"; then mv "$last/installed" "$last/restored"; fi
  exit 0
fi

for target in "${targets[@]}"; do
  if [[ -h "$skill_home/$(dirname "$target")" ]]; then
    printf 'Resolve the symlinked parent directory before installing: %s\n' "$skill_home/$(dirname "$target")" >&2
    exit 1
  fi
done

if "$dry_run"; then
  for target in "${targets[@]}"; do
    if exists "$skill_home/$target"; then printf 'Would back up %s under %s\n' "$skill_home/$target" "$backups"; fi
    if [[ "$operation" == backup ]]; then continue; fi
    if [[ "$target" == .local/* ]]; then
      printf 'Would link %s to %s\n' "$skill_home/$target" "$cli"
    elif [[ "$mode" == copy ]]; then
      printf 'Would copy %s into %s\n' "$repo_dir/skills/${target##*/}" "$skill_home/$target"
    else
      printf 'Would link %s to %s\n' "$skill_home/$target" "$repo_dir/skills/${target##*/}"
    fi
  done
  exit 0
fi

case "$operation" in
  backup) prefix=backup ;;
  install)
    prefix=install
    if [[ ! -x "$cli" ]]; then printf 'Build the CLI with pnpm --filter @esho-plans/cli build first.\n' >&2; exit 1; fi
    ;;
esac

umask 077
mkdir -p "$backups"
backup_dir="$(mktemp -d "$backups/$prefix.$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")"
save_backup "$backup_dir"
printf 'Verified backup %s\n' "$backup_dir"
if [[ "$operation" == backup ]]; then exit 0; fi

trap 'code=$?; trap - ERR; restore "$backup_dir"; exit "$code"' ERR
for target in "${targets[@]}"; do
  original="$skill_home/$target"
  mkdir -p "$(dirname "$original")"
  if exists "$original"; then
    mkdir -p "$backup_dir/originals/$(dirname "$target")"
    mv "$original" "$backup_dir/originals/$target"
    printf 'Moved %s into verified backup\n' "$original"
  fi
  if [[ "$target" == .local/* ]]; then
    ln -s "$cli" "$original"
    printf 'Linked %s to %s\n' "$original" "$cli"
  elif [[ "$mode" == copy ]]; then
    cp -pPR "$repo_dir/skills/${target##*/}" "$original"
    printf 'Copied skill into %s\n' "$original"
  else
    ln -s "$repo_dir/skills/${target##*/}" "$original"
    printf 'Linked %s\n' "$original"
  fi
done
touch "$backup_dir/installed"
trap - ERR
