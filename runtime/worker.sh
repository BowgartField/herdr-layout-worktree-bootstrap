#!/bin/sh
# Worktree bootstrap lifecycle worker for the Herdr app.
#
# Needs only POSIX sh and Git. The Herdr mod writes this file to each machine
# it uses (no separate installation) and runs it in a herdr-core terminal, so a
# setup or teardown keeps going when the app closes.
#
# Copy eligibility, the copy transaction, lifecycle execution and branch safety
# are ported from zerodice0/herdr-plugin-worktree-bootstrap (MIT); see NOTICE.
#
#   worker.sh install                   write the progress helpers beside it
#   worker.sh prepare ROOT ID JOB HOOKS create a job (JOB/HOOKS: sh assignments)
#   worker.sh run JOBDIR                run it; hook output goes to its log
#   worker.sh status ROOT ID...         JSON status of jobs
#   worker.sh retry JOBDIR HOOKS        requeue a failed job with fresh hooks
#   worker.sh logs JOBDIR               the last 32 KB of hook output
#   worker.sh gate JOBDIR               hold a terminal until setup succeeds
#   worker.sh progress --step S [--percent N]   called by hooks
set -u
umask 077

WTB_SELF=$0
case $WTB_SELF in /*) ;; *) WTB_SELF=$(pwd -P)/$WTB_SELF ;; esac
WTB_RUNTIME=$(dirname "$WTB_SELF")
TXN_PREFIX=.herdr-worktree-bootstrap-txn-
PROTECTED_BRANCHES="main master develop development trunk"
FIELDS_STR="id action source target branch state phase step error branch_result"
FIELDS_NUM="percent pid created queued_at updated revision copied_count finished"
FIELDS_BOOL="checkout_ready checkout_removed retryable"
WTB_LOCKS=
CHILD=
JOB=

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
now() { date +%s; }

# Quote a value for sh, so generated files never expand anything.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

json_str() {
  printf '"'
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | awk 'BEGIN { ORS = "" }
    { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r")
      if (NR > 1) printf "\\n"; printf "%s", $0 }'
  printf '"'
}

valid_id() { case $1 in *[!0-9a-f]*|'') return 1 ;; esac; [ ${#1} -eq 32 ]; }

# ---------------------------------------------------------------- status ---

get_field() { cat "$1/status/$2" 2>/dev/null; }
set_field() {
  printf '%s' "$3" > "$1/status/.$2.$$" && mv -f "$1/status/.$2.$$" "$1/status/$2"
}

status_lock() {
  _n=0
  while ! mkdir "$1/status.lock" 2>/dev/null; do
    _n=$((_n + 1))
    # A writer holds this for milliseconds; after ~5 s its owner died.
    if [ "$_n" -ge 100 ]; then rmdir "$1/status.lock" 2>/dev/null; _n=0; fi
    sleep 0.05
  done
}
status_unlock() { rmdir "$1/status.lock" 2>/dev/null; }

# update DIR [--only-running] key=value...
update() {
  _d=$1; shift
  _only=0
  if [ "${1:-}" = --only-running ]; then _only=1; shift; fi
  status_lock "$_d"
  if [ "$_only" = 1 ] && [ "$(get_field "$_d" state)" != running ]; then
    status_unlock "$_d"; return 1
  fi
  for _kv in "$@"; do set_field "$_d" "${_kv%%=*}" "${_kv#*=}"; done
  _rev=$(get_field "$_d" revision)
  set_field "$_d" revision $((${_rev:-0} + 1))
  set_field "$_d" updated "$(now)"
  status_unlock "$_d"
  return 0
}

status_json() {
  _d=$1; _sep=
  printf '{'
  for _f in $FIELDS_STR; do
    _v=$(get_field "$_d" "$_f")
    printf '%s"%s":' "$_sep" "$_f"; _sep=,
    if [ -z "$_v" ]; then printf null; else json_str "$_v"; fi
  done
  for _f in $FIELDS_NUM; do
    _v=$(get_field "$_d" "$_f")
    case $_v in ''|*[!0-9]*) _v=null ;; esac
    printf ',"%s":%s' "$_f" "$_v"
  done
  for _f in $FIELDS_BOOL; do
    _v=$(get_field "$_d" "$_f")
    case $_v in true|false) ;; *) _v=null ;; esac
    printf ',"%s":%s' "$_f" "$_v"
  done
  printf '}'
}

# A queued job that never started, or a runner that vanished, is failed.
check_liveness() {
  _d=$1
  case $(get_field "$_d" state) in
    queued)
      _q=$(get_field "$_d" queued_at); [ -n "$_q" ] || _q=$(get_field "$_d" created)
      if [ $(($(now) - ${_q:-0})) -gt 60 ]; then
        update "$_d" state=failed "step=Lifecycle job did not start" \
          "error=The lifecycle runner did not start; retry the operation"
      fi ;;
    running)
      _p=$(get_field "$_d" pid)
      if [ -n "$_p" ] && ! kill -0 "$_p" 2>/dev/null; then
        update "$_d" state=failed "step=Lifecycle job stopped" retryable=false \
          "error=The lifecycle runner stopped; hook processes may still be running. Inspect them before starting another operation."
      fi ;;
  esac
}

# ----------------------------------------------------------------- locks ---

# Exclusive and non-blocking; a lock whose owner died is taken over.
try_lock() {
  if ! mkdir "$1" 2>/dev/null; then
    _p=$(cat "$1/pid" 2>/dev/null)
    if [ -z "$_p" ]; then sleep 0.2; _p=$(cat "$1/pid" 2>/dev/null); fi
    if [ -n "$_p" ] && kill -0 "$_p" 2>/dev/null; then return 1; fi
    rm -rf "$1"
    mkdir "$1" 2>/dev/null || return 1
  fi
  printf '%s' "$$" > "$1/pid"
  WTB_LOCKS="$WTB_LOCKS
$1"
}

release_locks() {
  printf '%s\n' "$WTB_LOCKS" | while IFS= read -r _l; do
    [ -n "$_l" ] && [ "$(cat "$_l/pid" 2>/dev/null)" = "$$" ] && rm -rf "$_l"
  done
  WTB_LOCKS=
}

# ------------------------------------------------------------------- git ---

# The job fails with Git's message; never exposes hook commands.
fail() {
  update "$JOB" state=failed "error=$1" "step=Lifecycle job failed" "finished=$(now)"
  say "$1"
  exit 1
}

# git_run DIR ARGS...: GIT_OUT holds stdout; returns Git's status.
git_run() {
  _c=$1; shift
  GIT_OUT=$(git -C "$_c" "$@" 2>"$JOB/.git-error")
}
git_must() {
  _c=$1; shift
  git_run "$_c" "$@" || fail "git $1 failed: $(cat "$JOB/.git-error" 2>/dev/null | tail -n 5)"
}
canon() { (cd "$1" 2>/dev/null && pwd -P); }

# resolve PATH: R_TOP (its checkout), R_COMMON (shared .git), R_PRIMARY.
resolve() {
  [ -d "$1" ] || fail "target checkout is unavailable: $1"
  git_must "$1" rev-parse --is-bare-repository
  [ "$GIT_OUT" = false ] || fail "bare repositories do not have worktree files to bootstrap"
  git_must "$1" rev-parse --show-toplevel
  R_TOP=$(canon "$GIT_OUT")
  git_must "$1" rev-parse --git-common-dir
  case $GIT_OUT in /*) R_COMMON=$(canon "$GIT_OUT") ;; *) R_COMMON=$(cd "$1" && canon "$GIT_OUT") ;; esac
  git_must "$R_TOP" worktree list --porcelain
  # Git lists the primary checkout first.
  _first=$(printf '%s\n' "$GIT_OUT" | sed -n '1s/^worktree //p')
  if printf '%s\n' "$GIT_OUT" | sed '/^$/q' | grep -qx bare; then _first=; fi
  R_PRIMARY=$(canon "$_first")
  [ -n "$R_PRIMARY" ] || fail "the primary checkout is unavailable; nothing was changed"
  git_must "$R_PRIMARY" rev-parse --git-common-dir
  case $GIT_OUT in /*) _pc=$(canon "$GIT_OUT") ;; *) _pc=$(cd "$R_PRIMARY" && canon "$GIT_OUT") ;; esac
  [ "$_pc" = "$R_COMMON" ] || fail "source and target do not share the same common Git directory"
}

head_of() { git -C "$1" rev-parse --verify --quiet HEAD 2>/dev/null; }
branch_of() { git -C "$1" symbolic-ref --quiet --short HEAD 2>/dev/null; }

# "CRC LENGTH" of `git status`; a length of 0 means clean.
dirty_sum() {
  git -C "$1" --no-optional-locks status --porcelain=v1 -z --untracked-files=all \
    > "$JOB/.dirty" 2>"$JOB/.git-error" || fail "git status failed: $(cat "$JOB/.git-error")"
  cksum < "$JOB/.dirty" | awk '{ print $1 " " $2 }'
}
is_dirty() { [ "${1#* }" != 0 ]; }

# ------------------------------------------------------------------ copy ---

# Refuse symlinked or non-directory parents; with create=1, make them.
safe_parents() {
  _root=$1; _rest=$2; _cur=$1
  while :; do
    case $_rest in */*) ;; *) return 0 ;; esac
    _cur=$_cur/${_rest%%/*}; _rest=${_rest#*/}
    if [ -L "$_cur" ]; then COPY_ERROR="refusing to traverse symlink parent: ${_cur#"$_root"/}"; return 1; fi
    if [ ! -e "$_cur" ]; then
      [ "$3" = 1 ] || continue
      mkdir "$_cur" 2>/dev/null
      if [ -L "$_cur" ]; then COPY_ERROR="refusing to traverse symlink parent: ${_cur#"$_root"/}"; return 1; fi
    fi
    if [ ! -d "$_cur" ]; then COPY_ERROR="path parent is not a directory: ${_cur#"$_root"/}"; return 1; fi
  done
}

exists() { [ -e "$1" ] || [ -L "$1" ]; }

# Copy the configured ignored paths in one transaction: stage everything,
# then swap each into place, and put back what was there on any failure.
copy_files() {
  _src=$1; _dst=$2; COPIED=0; COPY_ERROR=
  for _old in "$_dst/$TXN_PREFIX"*; do
    exists "$_old" || continue
    rm -rf "$_old" || fail "cannot remove stale transaction ${_old##*/}"
  done
  _ready=
  _i=1
  while [ "$_i" -le "${copy_count:-0}" ]; do
    eval "_p=\$copy_$_i"
    safe_parents "$_src" "$_p" 0 && safe_parents "$_dst" "$_p" 0 || fail "$COPY_ERROR"
    git_run "$_src" ls-files -- "$_p" || fail "could not classify tracked path: $_p"
    if [ -n "$GIT_OUT" ]; then say "skip $_p: tracked by Git"
    else
      git -C "$_src" check-ignore -q --no-index -- "$_p" 2>/dev/null
      case $? in
        0) if exists "$_src/$_p"; then _ready="$_ready $_i"; else say "skip $_p: source does not exist"; fi ;;
        1) say "skip $_p: not ignored by Git" ;;
        *) fail "could not classify ignored path: $_p" ;;
      esac
    fi
    _i=$((_i + 1))
  done
  [ -n "$_ready" ] || return 0

  _txn=$_dst/$TXN_PREFIX$$-$(now)
  _done=
  if mkdir -p "$_txn/stage" "$_txn/backup" "$_txn/discarded"; then
    for _i in $_ready; do
      eval "_p=\$copy_$_i"
      safe_parents "$_src" "$_p" 0 || break
      if [ ! -L "$_src/$_p" ] && [ ! -f "$_src/$_p" ] && [ ! -d "$_src/$_p" ]; then
        COPY_ERROR="unsupported file type in copy list: ${_p##*/}"; break
      fi
      cp -pPR "$_src/$_p" "$_txn/stage/$_i" || { COPY_ERROR="cannot copy $_p"; break; }
    done
    if [ -z "$COPY_ERROR" ]; then
      for _i in $_ready; do
        eval "_p=\$copy_$_i"
        safe_parents "$_dst" "$_p" 1 || break
        if exists "$_dst/$_p"; then
          mv "$_dst/$_p" "$_txn/backup/$_i" || { COPY_ERROR="cannot replace $_p"; break; }
        fi
        if ! mv "$_txn/stage/$_i" "$_dst/$_p"; then
          exists "$_txn/backup/$_i" && ! exists "$_dst/$_p" && mv "$_txn/backup/$_i" "$_dst/$_p"
          COPY_ERROR="cannot place $_p"; break
        fi
        _done="$_i $_done"
        COPIED=$((COPIED + 1))
      done
    fi
  else
    COPY_ERROR="cannot create the copy transaction"
  fi
  if [ -n "$COPY_ERROR" ]; then
    _rollback=
    for _i in $_done; do
      eval "_p=\$copy_$_i"
      { ! exists "$_dst/$_p" || mv "$_dst/$_p" "$_txn/discarded/$_i"; } &&
        { ! exists "$_txn/backup/$_i" || mv "$_txn/backup/$_i" "$_dst/$_p"; } ||
        _rollback="$_rollback; $_p"
    done
    rm -rf "$_txn"
    [ -z "$_rollback" ] || COPY_ERROR="$COPY_ERROR; rollback errors:${_rollback#;}"
    fail "copy transaction failed: $COPY_ERROR"
  fi
  rm -rf "$_txn"
}

# ------------------------------------------------------------- lifecycle ---

lifecycle_env() { # BRANCH HEAD FORCED LEFTOVER
  export HERDR_WORKTREE_PATH="$T_TOP" HERDR_PRIMARY_PATH="$PRIMARY"
  export HERDR_WORKTREE_BRANCH="$1" HERDR_WORKTREE_HEAD="$2"
  export HERDR_REMOVAL_FORCED="$3" HERDR_LEFTOVER_DETECTED="$4"
  export HERDR_BOOTSTRAP_JOB_DIR="$JOB" HERDR_BOOTSTRAP_JOB_ID="${JOB##*/}"
  export HERDR_BOOTSTRAP_STATE_DIR="${JOB%/*}" HERDR_BOOTSTRAP_RUNNER="$WTB_SELF"
  export HERDR_PROGRESS_COMMAND="$WTB_RUNTIME/progress" HERDR_BIN_PATH="$WTB_RUNTIME/progress"
  # Opt-in shell functions; the configured argv itself is never shell-expanded.
  if [ -z "${BASH_ENV:-}" ]; then export BASH_ENV="$WTB_RUNTIME/progress.bash"; fi
}

run_phase() { # PHASE CWD
  PHASE=$1; HOOK_CWD=$2
  eval "HOOK_COUNT=\${hook_${PHASE}_count:-0}"
  case $PHASE in
    on_created) LABEL=setup; _s="Preparing worktree" ;;
    before_remove) LABEL=before-remove; _s="Preparing teardown" ;;
    *) LABEL=after-remove; _s="Finishing cleanup" ;;
  esac
  update "$JOB" "phase=$PHASE" "step=$_s" percent=
  HOOK_INDEX=1
  while [ "$HOOK_INDEX" -le "$HOOK_COUNT" ]; do
    "hook_${PHASE}_$HOOK_INDEX"
    HOOK_INDEX=$((HOOK_INDEX + 1))
  done
  if [ "$HOOK_COUNT" -gt 0 ]; then update "$JOB" --only-running "step=$LABEL complete" percent=100; fi
  return 0
}

# A process and everything it started (listed first, so none escapes by
# being reparented while the others are signalled).
kill_tree() { # SIGNAL PID
  _pids=$(ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$2" '
    { kids[$2] = kids[$2] " " $1 }
    END { queue = root; out = ""
      while (queue != "") {
        n = split(queue, q, " "); queue = ""
        for (i = 1; i <= n; i++) { out = out " " q[i]; if (q[i] in kids) queue = queue kids[q[i]] }
      }
      print out }')
  # shellcheck disable=SC2086
  kill -"$1" ${_pids:-$2} 2>/dev/null
  return 0
}

# Called by the hooks file: run_hook NAME TIMEOUT ARGV...
run_hook() {
  _name=$1; _timeout=$2; shift 2
  _step="$LABEL $HOOK_INDEX/$HOOK_COUNT: $_name"
  update "$JOB" --only-running "step=$(printf '%s' "$_step" | cut -c1-160)" \
    "percent=$(((HOOK_INDEX - 1) * 100 / HOOK_COUNT))"
  say "$_step"
  _where="$LABEL command $HOOK_INDEX ($_name)"
  # The script a command runs (./setup.sh, or bash setup.sh) may be given
  # relative to the repository: found in the hook's folder, else in the main
  # checkout. Nothing else in argv is rewritten.
  _script=0
  case $1 in
    /*) ;;
    */*) _script=1 ;;
    *) # An interpreter's first operand, unless it runs inline code.
       case ${1##*/} in
         sh|bash|dash|zsh|ksh|fish) _inline="-c" ;;
         node|bun|deno|tsx) _inline="-e --eval -p --print" ;;
         python|python3) _inline="-c -m" ;;
         ruby|perl) _inline="-e -E" ;;
         php) _inline="-r" ;;
         *) _inline= ;;
       esac
       if [ -n "$_inline" ]; then
         _n=0
         for _a in "$@"; do
           _n=$((_n + 1))
           [ "$_n" -gt 1 ] || continue
           case " $_inline - " in *" $_a "*) break ;; esac
           case $_a in -*) ;; *) _script=$_n; break ;; esac
         done
       fi ;;
  esac
  if [ "$_script" -gt 0 ]; then
    eval "_p=\${$_script}"
    case $_p in
      /*) ;;
      *) if ! exists "$HOOK_CWD/$_p" && [ -f "$PRIMARY/$_p" ]; then
           _i=1
           for _a in "$@"; do
             if [ "$_i" = "$_script" ]; then _a=$PRIMARY/$_p; fi
             set -- "$@" "$_a"; _i=$((_i + 1))
           done
           shift $((_i - 1))
         fi ;;
    esac
  fi
  (cd "$HOOK_CWD" && command -v "$1" >/dev/null 2>&1) || fail "$_where executable not found: $1"
  rm -f "$JOB/.timed-out"
  (cd "$HOOK_CWD" && exec "$@") </dev/null &
  CHILD=$!
  (sleep "$_timeout"; : > "$JOB/.timed-out"; kill_tree TERM "$CHILD"; sleep 2; kill_tree KILL "$CHILD") >/dev/null 2>&1 &
  _watch=$!
  wait "$CHILD"; _rc=$?
  kill_tree TERM "$_watch"; wait "$_watch" 2>/dev/null
  CHILD=
  [ ! -f "$JOB/.timed-out" ] || fail "$_where timed out after ${_timeout}s"
  [ "$_rc" -eq 0 ] || fail "$_where failed with exit code $_rc"
}

default_branch() {
  _d=$(git -C "$1" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -n "$_d" ]; then printf '%s' "${_d#*/}"; return; fi
  for _c in main master trunk develop development; do
    if git -C "$1" show-ref --verify --quiet "refs/heads/$_c"; then printf '%s' "$_c"; return; fi
  done
}

# Never deletes a protected, default, in-use or moved branch; safe never escalates.
delete_branch() { # REPO BRANCH force|safe EXPECTED_OID
  git -C "$1" check-ref-format --branch "$2" >/dev/null 2>&1 || fail "invalid local branch name"
  if ! git -C "$1" show-ref --verify --quiet "refs/heads/$2"; then BRANCH_RESULT=already_absent; return; fi
  for _p in $PROTECTED_BRANCHES "$(default_branch "$1")"; do
    [ "$2" != "$_p" ] || fail "refusing to delete protected branch: $2"
  done
  git_must "$1" worktree list --porcelain
  if printf '%s\n' "$GIT_OUT" | grep -qxF "branch refs/heads/$2"; then
    fail "refusing to delete a branch used by another worktree"
  fi
  [ "$(git -C "$1" rev-parse --verify --quiet "refs/heads/$2")" = "$4" ] ||
    fail "branch changed after it was displayed; review it again"
  if [ "$3" = force ]; then _flag=-D; BRANCH_RESULT=deleted_forcibly; else _flag=-d; BRANCH_RESULT=deleted_safely; fi
  if ! git -C "$1" branch "$_flag" -- "$2" >/dev/null 2>"$JOB/.git-error"; then
    if ! git -C "$1" show-ref --verify --quiet "refs/heads/$2"; then BRANCH_RESULT=already_absent; return; fi
    fail "$(cat "$JOB/.git-error" | tail -n 3)"
  fi
}

interrupted() {
  if [ -n "$CHILD" ]; then kill_tree TERM "$CHILD"; fi
  fail "Lifecycle job interrupted"
}

cmd_run() {
  JOB=${1%/}
  valid_id "${JOB##*/}" && [ -f "$JOB/job.sh" ] || die "Unknown lifecycle job"
  exec >>"$JOB/output.log" 2>&1
  trap release_locks EXIT
  try_lock "$JOB/job.lock" || { say "another bootstrap operation is already running for this job"; exit 75; }
  [ "$(get_field "$JOB" state)" != success ] || exit 0
  [ "$(get_field "$JOB" checkout_removed)" != true ] || { say "The checkout was removed; do not retry removal"; exit 1; }
  . "$JOB/job.sh"
  . "$JOB/hooks.sh"
  if [ -f "$JOB/snapshot.sh" ]; then . "$JOB/snapshot.sh"; fi
  update "$JOB" state=running "pid=$$" error= "step=Preparing lifecycle job" percent= finished= retryable=true
  trap interrupted TERM INT HUP

  resolve "$source"
  PRIMARY=$R_PRIMARY; P_COMMON=$R_COMMON
  _key=$(printf '%s\n%s' "$P_COMMON" "$target" | cksum | awk '{ print $1 "-" $2 }')
  mkdir -p "${JOB%/*}/.locks"
  try_lock "${JOB%/*}/.locks/target-$_key" || fail "another bootstrap operation is already running for this target"

  if [ "$action" = create ] && [ "$(get_field "$JOB" checkout_ready)" != true ]; then
    update "$JOB" phase=checkout "step=Creating worktree"
    if git -C "$PRIMARY" show-ref --verify --quiet "refs/heads/$branch"; then
      git_must "$checkout" worktree add "$target" "$branch"
    else
      git_must "$checkout" worktree add -b "$branch" "$target" "$base"
    fi
    update "$JOB" checkout_ready=true
  fi
  resolve "$target"
  T_TOP=$R_TOP
  if [ "$T_TOP" = "$PRIMARY" ] || [ "$R_COMMON" != "$P_COMMON" ]; then
    fail "Checkout identity no longer matches this job"
  fi

  if [ "$action" != remove ]; then
    update "$JOB" phase=copy "step=Copying local files" percent=0
    copy_files "$PRIMARY" "$T_TOP"
    update "$JOB" "copied_count=$COPIED"
    lifecycle_env "$(branch_of "$T_TOP")" "$(head_of "$T_TOP")" 0 0
    run_phase on_created "$T_TOP"
    update "$JOB" state=success phase=complete "step=Setup complete" percent=100 "finished=$(now)"
    return
  fi

  if [ "$(branch_of "$T_TOP")" != "$expected_branch" ] || [ "$(head_of "$T_TOP")" != "$expected_head" ]; then
    fail "The checkout changed; reopen removal to review it"
  fi
  lifecycle_env "$expected_branch" "$expected_head" "$force" 0
  run_phase before_remove "$T_TOP"
  # Hooks finish before Git may remove anything; then recheck what they left.
  resolve "$T_TOP"
  if [ "$R_COMMON" != "$P_COMMON" ] || [ "$(branch_of "$T_TOP")" != "$expected_branch" ] ||
     [ "$(head_of "$T_TOP")" != "$expected_head" ]; then
    fail "The checkout identity changed during teardown"
  fi
  _now=$(dirty_sum "$T_TOP")
  if is_dirty "$_now" && { [ "$force" != 1 ] || [ "$_now" != "$dirty_snapshot" ]; }; then
    fail "The checkout became dirty during teardown; review removal again"
  fi
  update "$JOB" phase=remove "step=Removing worktree" percent=
  if [ "$force" = 1 ]; then git_must "$PRIMARY" worktree remove --force "$T_TOP"
  else git_must "$PRIMARY" worktree remove "$T_TOP"; fi
  update "$JOB" checkout_removed=true
  _left=0; if exists "$T_TOP"; then _left=1; fi
  lifecycle_env "$expected_branch" "$expected_head" "$force" "$_left"
  run_phase after_remove "$PRIMARY"
  if [ "$branch_action" != keep ]; then
    update "$JOB" phase=branch "step=Cleaning up branch"
    delete_branch "$PRIMARY" "$expected_branch" "$branch_action" "$expected_head"
    update "$JOB" "branch_result=$BRANCH_RESULT"
  fi
  update "$JOB" state=success phase=complete "step=Cleanup complete" percent=100 "finished=$(now)"
}

# -------------------------------------------------------------- commands ---

cmd_prepare() { # ROOT ID JOB HOOKS
  [ $# -eq 4 ] || die "usage: prepare ROOT ID JOB HOOKS"
  valid_id "$2" || die "Invalid job identifier"
  mkdir -p "$1" || die "Cannot create the job folder"
  JOB=$1/$2
  mkdir "$JOB" "$JOB/status" || die "The job already exists"
  printf '%s\n' "$3" > "$JOB/job.sh"
  printf '%s\n' "$4" > "$JOB/hooks.sh"
  . "$JOB/job.sh"
  _ready=true; _branch=$branch
  if [ "$action" = create ]; then
    _ready=false
  else
    _head=$(head_of "$target"); _branch=$(branch_of "$target")
    _dirty=$(git -C "$target" --no-optional-locks status --porcelain=v1 -z --untracked-files=all 2>/dev/null | cksum | awk '{ print $1 " " $2 }')
    if [ "$action" = remove ] && is_dirty "$_dirty" && [ "$force" != 1 ]; then
      rm -rf "$JOB"; die "The checkout is dirty; explicit force confirmation is required"
    fi
    { printf 'expected_head=%s\n' "$(sq "$_head")"
      printf 'expected_branch=%s\n' "$(sq "$_branch")"
      printf 'dirty_snapshot=%s\n' "$(sq "$_dirty")"; } > "$JOB/snapshot.sh"
  fi
  _t=$(now)
  update "$JOB" "id=$2" "action=$action" "source=$source" "target=$target" "branch=$_branch" \
    state=queued phase=queued "step=Waiting for the lifecycle job" "created=$_t" "queued_at=$_t" \
    "checkout_ready=$_ready" checkout_removed=false retryable=true
  status_json "$JOB"; echo
}

cmd_retry() { # JOBDIR HOOKS
  JOB=${1%/}
  valid_id "${JOB##*/}" && [ -f "$JOB/job.sh" ] || die "Unknown lifecycle job"
  trap release_locks EXIT
  try_lock "$JOB/job.lock" || die "The lifecycle job is still running"
  if [ "$(get_field "$JOB" state)" != failed ] || [ "$(get_field "$JOB" checkout_removed)" = true ] ||
     [ "$(get_field "$JOB" retryable)" = false ]; then
    die "Only a failed setup/teardown before removal can be retried"
  fi
  printf '%s\n' "$2" > "$JOB/hooks.next" && mv -f "$JOB/hooks.next" "$JOB/hooks.sh"
  update "$JOB" state=queued pid= error= "queued_at=$(now)" "step=Waiting to retry lifecycle job"
  status_json "$JOB"; echo
}

cmd_status() { # ROOT ID...
  _root=$1; shift
  printf '['; _s=
  for _id in "$@"; do
    valid_id "$_id" || die "Invalid job identifier"
    [ -d "$_root/$_id/status" ] || continue
    check_liveness "$_root/$_id"
    printf '%s' "$_s"; status_json "$_root/$_id"; _s=,
  done
  printf ']\n'
}

cmd_logs() {
  if [ -s "$1/output.log" ]; then tail -c 32000 "$1/output.log"; else say "No hook output yet."; fi
}

cmd_progress() {
  if [ "${1:-}" = plugin ] && [ "${2:-}" = progress ] && [ "${3:-}" = report ]; then shift 3; fi
  _step=; _pct=
  while [ $# -gt 0 ]; do
    case $1 in
      --step) [ $# -ge 2 ] || die "--step needs a value"; _step=$2; shift 2 ;;
      --step=*) _step=${1#--step=}; shift ;;
      --percent) [ $# -ge 2 ] || die "--percent needs a value"; _pct=$2; shift 2 ;;
      --percent=*) _pct=${1#--percent=}; shift ;;
      *) die "Unknown progress option: $1" ;;
    esac
  done
  [ -n "${HERDR_BOOTSTRAP_JOB_DIR:-}" ] || die "Run this from a worktree lifecycle hook"
  _trim=$(printf '%s' "$_step" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  _len=$(printf '%s' "$_step" | wc -m | tr -d ' ')
  if [ -z "$_trim" ] || [ "$_len" -gt 160 ]; then die "The step must contain 1 to 160 characters"; fi
  case $_pct in
    '') ;;
    *[!0-9]*) die "The percentage must be between 0 and 100" ;;
    *) [ "$_pct" -le 100 ] || die "The percentage must be between 0 and 100" ;;
  esac
  # A late report never overwrites a finished job.
  update "$HERDR_BOOTSTRAP_JOB_DIR" --only-running "step=$_trim" "percent=$_pct" || true
}

# The first terminal of a new worktree: no shell until setup succeeds, and
# nothing typed meanwhile reaches the shell or agent that starts after it.
cmd_gate() {
  JOB=${1%/}
  valid_id "${JOB##*/}" && [ -f "$JOB/job.sh" ] || die "Unknown lifecycle job"
  trap '' INT QUIT
  _tty=0; _saved=
  if [ -t 0 ]; then _tty=1; _saved=$(stty -g); stty -echo; fi
  _last=
  while :; do
    check_liveness "$JOB"
    [ "$(get_field "$JOB" state)" != success ] || break
    _text=$(get_field "$JOB" error); [ -n "$_text" ] || _text=$(get_field "$JOB" step)
    [ -n "$_text" ] || _text="Preparing worktree"
    if [ "$_text" != "$_last" ]; then say "$_text"; _last=$_text; fi
    sleep 0.2
  done
  if [ "$_tty" = 1 ]; then
    stty -icanon min 0 time 0
    cat >/dev/null 2>&1
    stty "$_saved"
  fi
  trap - INT QUIT
  . "$JOB/job.sh"
  if command -v terminal_command >/dev/null 2>&1; then terminal_command; fi
  exec "${SHELL:-/bin/sh}" -l
}

cmd_install() {
  printf '#!/bin/sh\nexec sh "$(dirname "$0")/worker.sh" progress "$@"\n' > "$WTB_RUNTIME/progress.tmp" &&
    chmod 755 "$WTB_RUNTIME/progress.tmp" && mv -f "$WTB_RUNTIME/progress.tmp" "$WTB_RUNTIME/progress" || exit 1
  cat > "$WTB_RUNTIME/progress.bash.tmp" <<'EOF' || exit 1
# Loaded by non-interactive Bash lifecycle hooks when BASH_ENV is not already set.
herdr_progress() {
  command sh "$HERDR_BOOTSTRAP_RUNNER" progress "$@"
}
herdr_step() {
  herdr_progress --step "$1" "${@:2}"
}
EOF
  chmod 644 "$WTB_RUNTIME/progress.bash.tmp" && mv -f "$WTB_RUNTIME/progress.bash.tmp" "$WTB_RUNTIME/progress.bash"
}

_command=${1:-}
[ $# -gt 0 ] && shift
case $_command in
  install) cmd_install ;;
  prepare) cmd_prepare "$@" ;;
  run) [ $# -eq 1 ] || die "usage: run JOBDIR"; cmd_run "$1" ;;
  status) [ $# -ge 1 ] || die "usage: status ROOT ID..."; cmd_status "$@" ;;
  retry) [ $# -eq 2 ] || die "usage: retry JOBDIR HOOKS"; cmd_retry "$@" ;;
  logs) [ $# -eq 1 ] || die "usage: logs JOBDIR"; cmd_logs "$1" ;;
  gate) [ $# -eq 1 ] || die "usage: gate JOBDIR"; cmd_gate "$1" ;;
  progress) cmd_progress "$@" ;;
  plugin) cmd_progress plugin "$@" ;;
  *) die "usage: worker.sh install|prepare|run|status|retry|logs|gate|progress" ;;
esac
