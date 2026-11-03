# Loaded by non-interactive Bash lifecycle hooks when BASH_ENV is not already set.
herdr_progress() {
  command python3 "$HERDR_BOOTSTRAP_RUNNER" progress "$@"
}
herdr_step() {
  herdr_progress --step "$1" "${@:2}"
}
