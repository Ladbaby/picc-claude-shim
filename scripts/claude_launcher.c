/*
 * Native `claude.exe` launcher (Windows, built by scripts/build-exe.mjs via
 * gcc/mingw).
 *
 * Why this exists: the Claude Agent SDK (used by T3 Code) spawns the Claude
 * Code executable with NO shell and no PATHEXT resolution. Node >= 20.12
 * refuses to spawn `.cmd`/`.bat` files without a shell, so T3 requires a
 * real `claude.exe`. This tiny native binary satisfies that: it locates the
 * on-disk picc-claude-shim install and launches `node.exe bin/claude.js
 * <original argv...>`, forwarding stdio and the exit code. The fast-path
 * `--version` and the slow-path pi orchestrator both run under the normal
 * Node runtime, so behavior is identical to `node bin/claude.js` — with a
 * native executable front door the SDK can spawn.
 *
 * The shim root and node path are baked in at build time (see build-exe.mjs)
 * via -D macros. Runtime overrides:
 *   PICC_CLAUDE_SHIM_ROOT  directory containing bin/claude.js
 *   PICC_CLAUDE_NODE       absolute path to node.exe
 *
 * `shim_root` is re-resolved at runtime against the exe's own location
 * (<shim>/bin/claude.exe -> <shim>) so the binary keeps working if the whole
 * install is relocated, falling back to the baked-in root.
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdbool.h>
#include <windows.h>

#ifndef PICC_SHIM_ROOT
#define PICC_SHIM_ROOT ""
#endif
#ifndef PICC_NODE_EXE
#define PICC_NODE_EXE ""
#endif

static const char *SHIM_ROOT = PICC_SHIM_ROOT;
static const char *NODE_EXE = PICC_NODE_EXE;

static void die(const char *fmt, const char *arg) {
  fprintf(stderr, "claude.exe (picc-claude-shim): ");
  fprintf(stderr, fmt, arg ? arg : "");
  fprintf(stderr,
          "\nFix: rebuild with `node scripts/build-exe.mjs`, or set the "
          "PICC_CLAUDE_SHIM_ROOT / PICC_CLAUDE_NODE environment variables.\n");
  exit(1);
}

static bool file_exists(const char *p) {
  if (!p || !*p) return false;
  DWORD a = GetFileAttributesA(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

/* Returns a freshly malloc'd path "<root>/bin/claude.js". */
static char *join_shim_bin(const char *root) {
  size_t n = strlen(root) + strlen("/bin/claude.js") + 1;
  char *out = (char *)malloc(n);
  if (!out) return NULL;
  snprintf(out, n, "%s/bin/claude.js", root);
  return out;
}

/* Strip the final two path components: <shim>/bin/claude.exe -> <shim>. */
static char *shim_root_from_exe(const char *exe_path) {
  char *dir = strdup(exe_path);
  if (!dir) return NULL;
  char *s = strrchr(dir, '\\');
  if (s) *s = '\0'; else { s = strrchr(dir, '/'); if (s) *s = '\0'; }
  char *s2 = strrchr(dir, '\\');
  if (s2) *s2 = '\0'; else { s2 = strrchr(dir, '/'); if (s2) *s2 = '\0'; }
  return dir;
}

/* Resolve the shim root (malloc'd), valid iff <root>/bin/claude.js exists. */
static char *resolve_shim_root(const char *exe_path) {
  const char *env = getenv("PICC_CLAUDE_SHIM_ROOT");
  if (env && *env) {
    char *b = join_shim_bin(env);
    if (b && file_exists(b)) { free(b); return strdup(env); }
    free(b);
  }
  if (exe_path) {
    char *root = shim_root_from_exe(exe_path);
    if (root) {
      char *b = join_shim_bin(root);
      bool ok = b && file_exists(b);
      free(b);
      if (ok) return root;
      free(root);
    }
  }
  if (SHIM_ROOT && *SHIM_ROOT) {
    char *b = join_shim_bin(SHIM_ROOT);
    if (b && file_exists(b)) { free(b); return strdup(SHIM_ROOT); }
    free(b);
  }
  return NULL;
}

/* Resolve node.exe (malloc'd). */
static char *resolve_node_exe(void) {
  const char *env = getenv("PICC_CLAUDE_NODE");
  if (env && *env && file_exists(env)) return strdup(env);
  if (NODE_EXE && *NODE_EXE && file_exists(NODE_EXE)) return strdup(NODE_EXE);
  const char *path_var = getenv("PATH");
  if (path_var) {
    char *copy = strdup(path_var);
    if (copy) {
      char *save = NULL;
      char *tok = strtok_r(copy, ";:", &save);
      while (tok) {
        char cand[4096];
        snprintf(cand, sizeof(cand), "%s\\node.exe", tok);
        if (file_exists(cand)) {
          char *out = strdup(cand);
          free(copy);
          return out;
        }
        tok = strtok_r(NULL, ";:", &save);
      }
      free(copy);
    }
  }
  return NULL;
}

/* Wrap an argument in quotes for CreateProcessA's lpCommandLine, doubling
   any interior backslash that precedes a quote. */
static void append_quoted_arg(char *buf, size_t cap, size_t *len, const char *arg) {
  if (*len + 1 >= cap) return;
  buf[(*len)++] = '"';
  size_t al = strlen(arg);
  for (size_t i = 0; i < al; i++) {
    if (arg[i] == '"' && i + 1 < al && arg[i + 1] == '"') {
      /* literal backslash before an interior quote: double it */
      if (*len + 1 >= cap) return;
      buf[(*len)++] = '\\';
    }
    if (*len + 1 >= cap) return;
    buf[(*len)++] = arg[i];
  }
  if (*len + 1 >= cap) return;
  buf[(*len)++] = '"';
}

int main(int argc, char **argv) {
  char exe_path[MAX_PATH];
  GetModuleFileNameA(NULL, exe_path, MAX_PATH);

  char *shim_root = resolve_shim_root(exe_path);
  if (!shim_root) die("could not locate the picc-claude-shim install", NULL);
  char *shim_bin = join_shim_bin(shim_root);
  if (!shim_bin) die("out of memory", NULL);

  char *node = resolve_node_exe();
  if (!node) die("could not locate node.exe", NULL);

  /* Build the command line: "node" "<shim_bin>" <user args...> */
  size_t cap = strlen(node) + strlen(shim_bin) + 8;
  for (int i = 1; i < argc; i++) cap += strlen(argv[i]) + 3;
  cap += 64;
  char *cmd = (char *)malloc(cap);
  if (!cmd) die("out of memory", NULL);
  size_t len = 0;
  cmd[len] = '\0';
  append_quoted_arg(cmd, cap, &len, node);
  cmd[len++] = ' ';
  append_quoted_arg(cmd, cap, &len, shim_bin);
  for (int i = 1; i < argc; i++) {
    cmd[len++] = ' ';
    append_quoted_arg(cmd, cap, &len, argv[i]);
  }
  cmd[len] = '\0';

  STARTUPINFOA si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));

  if (!CreateProcessA(
        node, cmd, NULL, NULL, TRUE,
        CREATE_NO_WINDOW,
        NULL, NULL, &si, &pi)) {
    DWORD err = GetLastError();
    fprintf(stderr, "claude.exe: CreateProcess(node) failed, error %lu\n", err);
    return 127;
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);

  free(cmd);
  free(node);
  free(shim_bin);
  free(shim_root);
  return (int)code;
}
